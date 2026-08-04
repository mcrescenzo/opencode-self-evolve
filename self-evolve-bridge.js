import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  DEFAULT_BUDGETS,
  SCHEMA_VERSION,
  assertRecord,
  errorReasonCode,
  makeDecision,
  makeGlobalSettings,
  makeProposal,
  makeRepoSettings,
} from "./self-evolve-schemas.js";
import { processIsAlive, withStateMutationLock } from "./self-evolve-lock.js";
import { stateRootIdentity as computeStateRootIdentity } from "./self-evolve-state-root.js";
import {
  UI_CAPABILITIES,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
  UI_PROTOCOL_LIMITS,
  hashUiProtocol,
  makeUiDashboard,
  makeUiOperationRequest,
  makeUiOperationResponse,
  makeUiProjectionIndex,
  makeUiProtocolOffer,
  makeUiReviewDetail,
  negotiateUiProtocol,
} from "./self-evolve-ui-protocol.js";

export const BRIDGE_TTL_MS = 24 * 60 * 60 * 1000;
export const TUI_HOST_HEALTH_TTL_MS = 60 * 1000;
export const BRIDGE_ACTOR = "self-evolve-tui";
export const BRIDGE_SERVER_ACTOR = "self-evolve-integration";
export const BRIDGE_REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "requestId", "projectFingerprint", "proposalId", "targetHash",
  "proposedContentHash", "decisionVersion", "priorState", "newState", "actor",
  "timestamp", "nonce",
]);
export const DECISION_FEEDBACK_VERSION = 1;
export const DECISION_REJECTION_REASONS = Object.freeze([
  "incorrect-evidence", "already-covered", "wrong-scope", "too-specific",
  "not-worth-token-cost", "other",
]);
export const BRIDGE_FEEDBACK_REQUEST_FIELDS = Object.freeze([
  ...BRIDGE_REQUEST_FIELDS,
  "feedbackVersion", "feedback",
]);
export const BRIDGE_RESPONSE_FIELDS = Object.freeze([
  "schemaVersion", "requestId", "projectFingerprint", "proposalId", "ok", "status",
  "processedAt", "reason", "recovered",
]);
export const CONTROL_REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "requestId", "projectFingerprint", "actor", "timestamp",
  "settingsUpdatedAt", "settingsVersion", "nonce", "action", "payload",
]);
export const CONTROL_RESPONSE_FIELDS = Object.freeze([
  "schemaVersion", "requestId", "projectFingerprint", "ok", "status", "processedAt", "reason",
]);
export const CONTROL_STATE_FIELDS = Object.freeze([
  "schemaVersion", "projectFingerprint", "actor", "issuedAt", "expiresAt", "settingsUpdatedAt",
  "settingsVersion", "stateRootIdentity", "nonce", "mode", "effectiveMode", "allowedSkillRoots", "consent", "repoExcluded",
]);
export const TUI_HOST_HEALTH_FIELDS = Object.freeze([
  "schemaVersion", "projectFingerprint", "actor", "issuedAt", "expiresAt",
  "stateRootIdentity", "hostVersion", "publisherPid", "nonce",
]);
export const CONTROL_ACTIONS = Object.freeze([
  "set-mode", "set-consent", "set-repo-excluded", "set-repo-mode", "update-allowlist",
]);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024;
const MAX_CONTROL_STATE_BYTES = 8 * 1024;
const MAX_RECORD_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_MAILBOX_BYTES = 512 * 1024;
const MAX_MAILBOX_FILES = 64;
const MAX_STORE_RESERVE_BYTES = 64 * 1024;
const MAX_UI_PROJECTION_FILES = 3 + UI_PROTOCOL_LIMITS.reviewIndexEntries;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const HOST_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const CONSENT_KEYS = new Set(["passiveCalls", "durableObservations", "sanitizedExcerpts", "crossRepoAggregation"]);
const NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0 ? constants.O_NOFOLLOW : null;
export const BRIDGE_RESPONSE_RESERVE_BYTES = MAX_RESPONSE_BYTES;
export const BRIDGE_CONTROL_STATE_RESERVE_BYTES = MAX_CONTROL_STATE_BYTES;

function exactKeys(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}-malformed`);
  const expected = new Set(fields);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new TypeError(`${label}-unknown-field`);
  for (const key of fields) if (!(key in value)) throw new TypeError(`${label}-missing-field`);
}

function validId(value, label) {
  const clean = String(value ?? "");
  if (!ID_PATTERN.test(clean)) throw new TypeError(`invalid-${label}`);
  return clean;
}

function validHash(value, label) {
  const clean = String(value ?? "");
  if (!HASH_PATTERN.test(clean)) throw new TypeError(`invalid-${label}`);
  return clean;
}

function validTimestamp(value, label = "timestamp") {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid-${label}`);
  return value;
}

function canonicalRoots(value, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > 32 || (nonEmpty && value.length === 0)) throw new TypeError("invalid-control-allowlist");
  const roots = value.map((item) => {
    if (typeof item !== "string" || !item || item.length > 4096 || !path.isAbsolute(item) || path.resolve(item) !== item) throw new TypeError("invalid-control-allowlist");
    return item;
  });
  if (new Set(roots).size !== roots.length) throw new TypeError("invalid-control-allowlist");
  return Object.freeze(roots);
}

function boundedJson(value, maxBytes, label) {
  const source = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(source) > maxBytes) throw new Error(`${label}-oversized`);
  return source;
}

function missing(error) {
  return error?.code === "ENOENT";
}

function lstatOptional(filePath) {
  try { return lstatSync(filePath); } catch (error) { if (missing(error)) return null; throw error; }
}

function assertInside(boundary, candidate) {
  const relative = path.relative(boundary, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error("bridge-path-escape-rejected");
}

function stateBoundary(stateRoot) {
  const requested = path.resolve(String(stateRoot ?? ""));
  const entry = lstatOptional(requested);
  if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error("state-root-boundary-rejected");
  const canonical = realpathSync(requested);
  if (canonical !== requested) throw new Error("state-root-boundary-rejected");
  return canonical;
}

function walkDirectories(boundary, components, { create = false } = {}) {
  let current = boundary;
  for (const component of components) {
    if (!component || component === "." || component === ".." || component.includes(path.sep)) throw new Error("bridge-component-rejected");
    const next = path.join(current, component);
    assertInside(boundary, next);
    let entry = lstatOptional(next);
    if (!entry && create) {
      try { mkdirSync(next, { mode: DIR_MODE }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      entry = lstatOptional(next);
    }
    if (!entry) return null;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("bridge-ancestor-rejected");
    const canonical = realpathSync(next);
    assertInside(boundary, canonical);
    if (canonical !== next) throw new Error("bridge-ancestor-rejected");
    current = next;
  }
  return current;
}

function bridgePaths(stateRoot, projectFingerprint, { create = false } = {}) {
  const fingerprint = validHash(projectFingerprint, "project-fingerprint");
  const boundary = stateBoundary(stateRoot);
  const root = walkDirectories(boundary, ["self-evolve", "bridge", fingerprint], { create });
  if (!root) return null;
  const requests = walkDirectories(boundary, ["self-evolve", "bridge", fingerprint, "requests"], { create });
  const responses = walkDirectories(boundary, ["self-evolve", "bridge", fingerprint, "responses"], { create });
  const controlRequests = walkDirectories(boundary, ["self-evolve", "bridge", fingerprint, "control-requests"], { create });
  const controlResponses = walkDirectories(boundary, ["self-evolve", "bridge", fingerprint, "control-responses"], { create });
  const operationRequests = walkDirectories(boundary, ["self-evolve", "bridge", fingerprint, "operation-requests"], { create });
  const operationResponses = walkDirectories(boundary, ["self-evolve", "bridge", fingerprint, "operation-responses"], { create });
  if (![requests, responses, controlRequests, controlResponses, operationRequests, operationResponses].every(Boolean)) return null;
  return {
    boundary, fingerprint, root, requests, responses, controlRequests, controlResponses,
    operationRequests, operationResponses,
    lock: path.join(root, "consumer.lock"),
    controlState: path.join(root, "control-state.json"),
    tuiHostHealth: path.join(root, "tui-host-health.json"),
  };
}

function uiProjectionPaths(paths, { create = false, generation } = {}) {
  const root = walkDirectories(paths.boundary, [
    "self-evolve", "bridge", paths.fingerprint, "ui-projections",
  ], { create });
  if (!root) return null;
  const generations = walkDirectories(paths.boundary, [
    "self-evolve", "bridge", paths.fingerprint, "ui-projections", "generations",
  ], { create });
  if (!generations) return null;
  let generationRoot = null;
  let details = null;
  if (generation !== undefined) {
    const cleanGeneration = validHash(generation, "projection-generation");
    generationRoot = walkDirectories(paths.boundary, [
      "self-evolve", "bridge", paths.fingerprint, "ui-projections", "generations", cleanGeneration,
    ], { create });
    if (generationRoot) {
      details = walkDirectories(paths.boundary, [
        "self-evolve", "bridge", paths.fingerprint, "ui-projections", "generations", cleanGeneration, "details",
      ], { create });
    }
    if (!generationRoot || !details) return null;
  }
  return {
    root,
    generations,
    generationRoot,
    details,
    offer: path.join(root, "protocol-offer.json"),
    index: path.join(root, "index.json"),
    dashboard: generationRoot ? path.join(generationRoot, "dashboard-v1.json") : null,
  };
}

function projectionDetailPath(projectionPathsValue, proposalId) {
  if (!projectionPathsValue?.details) throw new Error("ui-projection-generation-unavailable");
  const id = String(proposalId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(id)) throw new TypeError("invalid-proposal-id");
  const fileName = createHash("sha256").update(`self-evolve-ui-detail-path-v1\n${id}`).digest("hex");
  return path.join(projectionPathsValue.details, `${fileName}.json`);
}

function revalidateDirectory(boundary, directory) {
  assertInside(boundary, directory);
  const relative = path.relative(boundary, directory);
  const components = relative ? relative.split(path.sep) : [];
  const walked = walkDirectories(boundary, components);
  if (walked !== directory) throw new Error("bridge-ancestor-replaced");
}

function assertRegularSingleLink(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}-path-rejected`);
  if (stat.nlink !== 1) throw new Error(`${label}-hardlink-rejected`);
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function secureRead(paths, filePath, maxBytes, label) {
  if (NOFOLLOW === null) throw new Error("bridge-no-follow-unsupported");
  const parent = path.dirname(filePath);
  revalidateDirectory(paths.boundary, parent);
  const before = lstatOptional(filePath);
  if (!before) return null;
  assertRegularSingleLink(before, label);
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(descriptor);
    assertRegularSingleLink(opened, label);
    if (!sameInode(before, opened)) throw new Error(`${label}-replaced`);
    if (opened.size > maxBytes) throw new Error(`${label}-oversized`);
    const source = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(source) > maxBytes) throw new Error(`${label}-oversized`);
    const after = lstatOptional(filePath);
    if (!after || !sameInode(opened, after) || after.nlink !== 1) throw new Error(`${label}-replaced`);
    revalidateDirectory(paths.boundary, parent);
    return { source, stat: opened };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function effectiveUserId(override) {
  const value = override === undefined && typeof process.geteuid === "function"
    ? process.geteuid()
    : override;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("tui-host-health-owner-validation-unsupported");
  return value;
}

function assertTuiHostHealthAncestors(paths, uid) {
  const boundary = lstatSync(paths.boundary);
  if (!boundary.isDirectory() || boundary.isSymbolicLink()) throw new Error("tui-host-health-state-root-rejected");
  if (boundary.uid !== uid) throw new Error("tui-host-health-state-root-owner-rejected");
  if ((boundary.mode & 0o022) !== 0) throw new Error("tui-host-health-state-root-permissions-rejected");
  const relative = path.relative(paths.boundary, paths.root);
  let current = paths.boundary;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("tui-host-health-ancestor-rejected");
    if (stat.uid !== uid) throw new Error("tui-host-health-ancestor-owner-rejected");
    if ((stat.mode & 0o022) !== 0) throw new Error("tui-host-health-ancestor-permissions-rejected");
  }
}

function secureReadTuiHostHealth(paths, { effectiveUid } = {}) {
  const uid = effectiveUserId(effectiveUid);
  assertTuiHostHealthAncestors(paths, uid);
  const read = secureRead(paths, paths.tuiHostHealth, MAX_RESPONSE_BYTES, "tui-host-health");
  if (!read) return null;
  if (read.stat.uid !== uid) throw new Error("tui-host-health-file-owner-rejected");
  if ((read.stat.mode & 0o777) !== FILE_MODE) throw new Error("tui-host-health-mode-rejected");
  assertTuiHostHealthAncestors(paths, uid);
  return read;
}

function assertPrivateProjectionAncestors(paths, directory, uid = effectiveUserId()) {
  const relative = path.relative(paths.boundary, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("ui-projection-path-escape-rejected");
  }
  let current = paths.boundary;
  const boundary = lstatSync(current);
  if (!boundary.isDirectory() || boundary.isSymbolicLink() || boundary.uid !== uid) throw new Error("ui-projection-owner-rejected");
  if ((boundary.mode & 0o022) !== 0 || realpathSync(current) !== current) throw new Error("ui-projection-boundary-permissions-rejected");
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ui-projection-ancestor-rejected");
    if (stat.uid !== uid) throw new Error("ui-projection-owner-rejected");
    const projectionRelative = path.relative(path.join(paths.root, "ui-projections"), current);
    const privateProjectionDirectory = projectionRelative === ""
      || (!projectionRelative.startsWith(`..${path.sep}`) && projectionRelative !== ".." && !path.isAbsolute(projectionRelative));
    if ((stat.mode & (privateProjectionDirectory ? 0o077 : 0o022)) !== 0) {
      throw new Error(privateProjectionDirectory
        ? "ui-projection-private-directory-permissions-rejected"
        : "ui-projection-ancestor-permissions-rejected");
    }
    if (realpathSync(current) !== current) throw new Error("ui-projection-ancestor-rejected");
  }
}

function assertUiProjectionBoundary(boundary, uid = effectiveUserId()) {
  const stat = lstatSync(boundary);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) throw new Error("ui-projection-owner-rejected");
  if ((stat.mode & 0o022) !== 0 || realpathSync(boundary) !== boundary) {
    throw new Error("ui-projection-boundary-permissions-rejected");
  }
}

function secureProjectionRead(paths, filePath, maxBytes, label, { effectiveUid } = {}) {
  const uid = effectiveUserId(effectiveUid);
  assertPrivateProjectionAncestors(paths, path.dirname(filePath), uid);
  const read = secureRead(paths, filePath, maxBytes, label);
  if (!read) return null;
  if (read.stat.uid !== uid) throw new Error(`${label}-owner-rejected`);
  if ((read.stat.mode & 0o777) !== FILE_MODE) throw new Error(`${label}-mode-rejected`);
  assertPrivateProjectionAncestors(paths, path.dirname(filePath), uid);
  return read;
}

function assertPrivateProjectionTree(paths, projectionRoot, uid = effectiveUserId()) {
  const root = lstatOptional(projectionRoot);
  if (!root) return;
  assertPrivateProjectionAncestors(paths, projectionRoot, uid);
  const visit = (directory) => {
    assertPrivateProjectionAncestors(paths, directory, uid);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) throw new Error("ui-projection-symlink-rejected");
      if (stat.uid !== uid) throw new Error("ui-projection-owner-rejected");
      if (entry.isDirectory()) {
        if ((stat.mode & 0o077) !== 0 || realpathSync(filePath) !== filePath) throw new Error("ui-projection-private-directory-permissions-rejected");
        visit(filePath);
      } else if (entry.isFile()) {
        if (stat.nlink !== 1) throw new Error("ui-projection-hardlink-rejected");
        if ((stat.mode & 0o777) !== FILE_MODE) throw new Error("ui-projection-mode-rejected");
      } else {
        throw new Error("ui-projection-path-rejected");
      }
    }
  };
  visit(projectionRoot);
}

function safeTreeUsage(paths, directory) {
  const root = lstatOptional(directory);
  if (!root) return { bytes: 0, files: [] };
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("mailbox-quota-path-rejected");
  revalidateDirectory(paths.boundary, directory);
  const files = [];
  const visit = (current) => {
    revalidateDirectory(paths.boundary, current);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      const stat = lstatOptional(filePath);
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new Error("mailbox-quota-symlink-rejected");
      if (stat.isDirectory()) visit(filePath);
      else if (stat.isFile()) files.push({ filePath, size: stat.size });
      else throw new Error("mailbox-quota-path-rejected");
    }
  };
  visit(directory);
  return { bytes: files.reduce((sum, file) => sum + file.size, 0), files };
}

function quotaBytesFor(paths) {
  const globalPath = path.join(paths.boundary, "self-evolve", "global", "settings.json");
  const repoPath = path.join(paths.boundary, "self-evolve", paths.fingerprint, "settings.json");
  let globalQuotaMiB = DEFAULT_BUDGETS.storageQuotaMiB;
  if (lstatOptional(globalPath)) {
    const read = secureRead(paths, globalPath, MAX_SETTINGS_BYTES, "global-settings");
    globalQuotaMiB = makeGlobalSettings(JSON.parse(read.source)).budgets.storageQuotaMiB;
  }
  let quotaMiB = globalQuotaMiB;
  if (lstatOptional(repoPath)) {
    const read = secureRead(paths, repoPath, MAX_SETTINGS_BYTES, "repo-settings");
    const repo = makeRepoSettings(JSON.parse(read.source));
    if (repo.projectFingerprint !== paths.fingerprint) throw new Error("project-partition-mismatch");
    quotaMiB = repo.budgets.storageQuotaMiB ?? globalQuotaMiB;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, quotaMiB * 1024 * 1024);
}

function pendingRequestCount(paths, files) {
  const requestRoots = new Set([paths.requests, paths.controlRequests, paths.operationRequests]);
  return files.filter((file) => requestRoots.has(path.dirname(file.filePath)) && file.filePath.endsWith(".json")).length;
}

function assertMailboxPublication(paths, target, source, { request = false, removePath } = {}) {
  const quotaBytes = quotaBytesFor(paths);
  const stateDir = path.join(paths.boundary, "self-evolve", paths.fingerprint);
  const stateUsage = safeTreeUsage(paths, stateDir);
  const bridgeUsage = safeTreeUsage(paths, paths.root);
  const existing = lstatOptional(target);
  if (existing) assertRegularSingleLink(existing, "mailbox-publication");
  const removed = removePath ? lstatOptional(removePath) : null;
  if (removed) assertRegularSingleLink(removed, "mailbox-removal");
  const sourceBytes = Buffer.byteLength(source, "utf8");
  const existingBytes = existing?.size ?? 0;
  const removedBytes = removed?.size ?? 0;
  const removingPending = removed && [
    paths.requests,
    paths.controlRequests,
    paths.operationRequests,
  ].includes(path.dirname(removePath)) ? 1 : 0;
  const pending = pendingRequestCount(paths, bridgeUsage.files) - removingPending + (request && !existing ? 1 : 0);
  const controlStateReserve = pending > 0 && !lstatOptional(paths.controlState) ? MAX_CONTROL_STATE_BYTES : 0;
  const projectedProjectBytes = stateUsage.bytes + bridgeUsage.bytes - existingBytes - removedBytes + sourceBytes + controlStateReserve;
  const reserveBytes = Math.min(MAX_STORE_RESERVE_BYTES, Math.floor(quotaBytes / 8));
  const growing = sourceBytes > existingBytes + removedBytes;
  const projectLimit = request ? Math.max(0, quotaBytes - reserveBytes) : quotaBytes;
  if (growing && projectedProjectBytes > projectLimit) {
    throw new Error("mailbox-byte-quota-exceeded");
  }

  const projectedMailboxBytes = bridgeUsage.bytes - existingBytes - removedBytes + sourceBytes + pending * MAX_RESPONSE_BYTES + controlStateReserve;
  const mailboxQuotaBytes = Math.min(MAX_MAILBOX_BYTES, Math.floor(quotaBytes / 8));
  if (growing && projectedMailboxBytes > mailboxQuotaBytes) throw new Error("mailbox-byte-quota-exceeded");
  if (request && pending > MAX_MAILBOX_FILES) throw new Error("mailbox-file-count-exceeded");
  return { projectedProjectBytes, projectedMailboxBytes, projectedRequestCount: pending, quotaBytes, mailboxQuotaBytes };
}

function assertUiProjectionPublication(paths, plannedFiles) {
  if (!(plannedFiles instanceof Map) || plannedFiles.size < 2 || plannedFiles.size > MAX_UI_PROJECTION_FILES) {
    throw new Error("ui-projection-file-count-exceeded");
  }
  const quotaBytes = quotaBytesFor(paths);
  const stateUsage = safeTreeUsage(paths, path.join(paths.boundary, "self-evolve", paths.fingerprint));
  const bridgeUsage = safeTreeUsage(paths, paths.root);
  let replacedBytes = 0;
  let sourceBytes = 0;
  for (const [filePath, source] of plannedFiles) {
    assertInside(paths.root, filePath);
    if (typeof source !== "string") throw new TypeError("ui-projection-source-required");
    const existing = lstatOptional(filePath);
    if (existing) {
      assertRegularSingleLink(existing, "ui-projection-publication");
      replacedBytes += existing.size;
    }
    sourceBytes += Buffer.byteLength(source, "utf8");
  }
  const projectedProjectBytes = stateUsage.bytes + bridgeUsage.bytes - replacedBytes + sourceBytes;
  if (projectedProjectBytes > quotaBytes && sourceBytes > replacedBytes) throw new Error("ui-projection-byte-quota-exceeded");
  return { projectedProjectBytes, quotaBytes };
}

function secureUnlink(paths, filePath, expected, { allowSymlink = false, expectedLinks = 1 } = {}) {
  const parent = path.dirname(filePath);
  revalidateDirectory(paths.boundary, parent);
  const current = lstatOptional(filePath);
  if (!current) return false;
  if (current.isSymbolicLink()) {
    if (!allowSymlink) throw new Error("bridge-symlink-rejected");
  } else {
    if (!current.isFile() || current.nlink !== expectedLinks) throw new Error("bridge-unlink-path-rejected");
    if (expected && !sameInode(current, expected)) throw new Error("bridge-unlink-replaced");
  }
  revalidateDirectory(paths.boundary, parent);
  unlinkSync(filePath);
  return true;
}

function removePrivateProjectionTree(paths, directory) {
  assertInside(paths.root, directory);
  const stat = lstatOptional(directory);
  if (!stat) return 0;
  if (stat.isSymbolicLink()) {
    secureUnlink(paths, directory, stat, { allowSymlink: true });
    return 1;
  }
  if (stat.isFile()) {
    assertRegularSingleLink(stat, "ui-projection-cleanup");
    return secureUnlink(paths, directory, stat) ? 1 : 0;
  }
  if (!stat.isDirectory() || realpathSync(directory) !== directory) throw new Error("ui-projection-path-rejected");
  let removed = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const child = lstatSync(filePath);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removed += removePrivateProjectionTree(paths, filePath);
      continue;
    }
    if (child.isSymbolicLink()) {
      if (secureUnlink(paths, filePath, child, { allowSymlink: true })) removed += 1;
      continue;
    }
    assertRegularSingleLink(child, "ui-projection-cleanup");
    if (secureUnlink(paths, filePath, child)) removed += 1;
  }
  revalidateDirectory(paths.boundary, path.dirname(directory));
  rmdirSync(directory);
  return removed;
}

function atomicWrite(paths, filePath, source, { exclusive = false } = {}) {
  if (NOFOLLOW === null) throw new Error("bridge-no-follow-unsupported");
  const parent = path.dirname(filePath);
  revalidateDirectory(paths.boundary, parent);
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  let temporaryStat;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, FILE_MODE);
    writeFileSync(descriptor, source, "utf8");
    fsyncSync(descriptor);
    temporaryStat = fstatSync(descriptor);
    assertRegularSingleLink(temporaryStat, "bridge-temporary");
    closeSync(descriptor);
    descriptor = undefined;
    revalidateDirectory(paths.boundary, parent);
    const existing = lstatOptional(filePath);
    if (exclusive && existing) {
      const error = new Error("bridge-file-exists");
      error.code = "EEXIST";
      throw error;
    }
    if (!exclusive && existing) assertRegularSingleLink(existing, "bridge-publication");
    if (exclusive) {
      linkSync(temporary, filePath);
      const published = lstatSync(filePath);
      if (!sameInode(temporaryStat, published) || published.nlink !== 2) throw new Error("bridge-publication-replaced");
      secureUnlink(paths, temporary, temporaryStat, { expectedLinks: 2 });
      const final = lstatSync(filePath);
      if (!sameInode(published, final) || final.nlink !== 1) throw new Error("bridge-publication-replaced");
    } else {
      renameSync(temporary, filePath);
      const published = lstatSync(filePath);
      if (!sameInode(temporaryStat, published) || published.nlink !== 1) throw new Error("bridge-publication-replaced");
    }
    revalidateDirectory(paths.boundary, parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      const leftover = lstatOptional(temporary);
      if (leftover) secureUnlink(paths, temporary, temporaryStat, { expectedLinks: leftover.nlink });
    } catch (error) { if (!missing(error) && lstatOptional(temporary)) throw error; }
  }
}

function sameAccountProcessIsAlive(pid, signalProcess = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { signalProcess(pid, 0); return true; } catch { return false; }
}

export function makeBridgeRequest(value, { now = Date.now(), maxAgeMs = BRIDGE_TTL_MS, projectFingerprint } = {}) {
  const hasFeedbackFields = Object.hasOwn(value ?? {}, "feedbackVersion")
    || Object.hasOwn(value ?? {}, "feedback");
  exactKeys(value, hasFeedbackFields ? BRIDGE_FEEDBACK_REQUEST_FIELDS : BRIDGE_REQUEST_FIELDS, "bridge-request");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("unsupported-schema-version");
  let feedback;
  if (hasFeedbackFields) {
    if (value.feedbackVersion !== DECISION_FEEDBACK_VERSION) throw new TypeError("unsupported-decision-feedback-version");
    exactKeys(value.feedback, ["reason", "text"], "decision-feedback");
    if (value.newState !== "rejected" || !DECISION_REJECTION_REASONS.includes(value.feedback.reason)) {
      throw new TypeError("invalid-decision-feedback-reason");
    }
    if (value.feedback.text !== null
        && (typeof value.feedback.text !== "string"
          || value.feedback.text.length < 1
          || value.feedback.text.length > 512
          || Buffer.byteLength(value.feedback.text, "utf8") > 1_024)) {
      throw new TypeError("invalid-decision-feedback-text");
    }
    if (value.feedback.reason !== "other" && value.feedback.text !== null) {
      throw new TypeError("unexpected-decision-feedback-text");
    }
    feedback = Object.freeze({ reason: value.feedback.reason, text: value.feedback.text });
  }
  const request = Object.freeze({
    schemaVersion: value.schemaVersion,
    requestId: validId(value.requestId, "request-id"),
    projectFingerprint: validHash(value.projectFingerprint, "project-fingerprint"),
    proposalId: validId(value.proposalId, "proposal-id"),
    targetHash: value.targetHash === "must-not-exist" ? "must-not-exist" : validHash(value.targetHash, "target-hash"),
    proposedContentHash: validHash(value.proposedContentHash, "proposed-content-hash"),
    decisionVersion: value.decisionVersion,
    priorState: value.priorState,
    newState: value.newState,
    actor: value.actor,
    timestamp: validTimestamp(value.timestamp),
    nonce: validId(value.nonce, "nonce"),
    ...(hasFeedbackFields ? {
      feedbackVersion: DECISION_FEEDBACK_VERSION,
      feedback,
    } : {}),
  });
  makeDecision({
    proposalId: request.proposalId,
    targetHash: request.targetHash,
    proposedContentHash: request.proposedContentHash,
    decisionVersion: request.decisionVersion,
    actor: request.actor,
    timestamp: request.timestamp,
    nonce: request.nonce,
    priorState: request.priorState,
    newState: request.newState,
  });
  if (projectFingerprint && request.projectFingerprint !== projectFingerprint) throw new TypeError("cross-project-request");
  if (request.actor !== BRIDGE_ACTOR) throw new TypeError("invalid-bridge-actor");
  if (request.timestamp > now + 30_000) throw new TypeError("future-request");
  if (now - request.timestamp > maxAgeMs) throw new TypeError("stale-request");
  return request;
}

export function makeBridgeResponse(value) {
  const normalized = { ...value, reason: value.reason ?? null, recovered: value.recovered === true };
  exactKeys(normalized, BRIDGE_RESPONSE_FIELDS, "bridge-response");
  if (normalized.schemaVersion !== SCHEMA_VERSION) throw new TypeError("unsupported-schema-version");
  const response = Object.freeze({
    schemaVersion: normalized.schemaVersion,
    requestId: validId(normalized.requestId, "request-id"),
    projectFingerprint: validHash(normalized.projectFingerprint, "project-fingerprint"),
    proposalId: validId(normalized.proposalId, "proposal-id"),
    ok: normalized.ok === true,
    status: normalized.status === "accepted" ? "accepted" : normalized.status === "rejected" ? "rejected" : (() => { throw new TypeError("invalid-response-status"); })(),
    processedAt: validTimestamp(normalized.processedAt, "processed-at"),
    reason: normalized.reason === null ? null : String(normalized.reason).slice(0, 256),
    recovered: normalized.recovered,
  });
  if (response.ok !== (response.status === "accepted")) throw new TypeError("inconsistent-response-status");
  return response;
}

function controlPayload(action, value) {
  if (action === "set-mode") {
    if (value?.mode === "manual" || value?.mode === "auto") {
      exactKeys(value, ["mode"], "control-payload");
      return Object.freeze({ mode: value.mode });
    }
    exactKeys(value, ["mode", "allowlist", "confirmation"], "control-payload");
    if (value.mode !== "yolo" || value.confirmation !== "ENABLE YOLO") throw new TypeError("invalid-yolo-confirmation");
    return Object.freeze({ mode: "yolo", allowlist: canonicalRoots(value.allowlist, { nonEmpty: true }), confirmation: value.confirmation });
  }
  if (action === "set-consent") {
    exactKeys(value, ["key", "enabled"], "control-payload");
    if (!CONSENT_KEYS.has(value.key) || typeof value.enabled !== "boolean") throw new TypeError("invalid-consent-control");
    return Object.freeze({ key: value.key, enabled: value.enabled });
  }
  if (action === "set-repo-excluded") {
    exactKeys(value, ["excluded"], "control-payload");
    if (typeof value.excluded !== "boolean") throw new TypeError("invalid-exclusion-control");
    return Object.freeze({ excluded: value.excluded });
  }
  if (action === "set-repo-mode") {
    exactKeys(value, ["mode"], "control-payload");
    if (!["inherit", "manual", "auto", "yolo"].includes(value.mode)) {
      throw new TypeError("invalid-repository-mode-control");
    }
    return Object.freeze({ mode: value.mode });
  }
  if (action === "update-allowlist") {
    exactKeys(value, ["allowlist", "confirmation"], "control-payload");
    if (value.confirmation !== "UPDATE ALLOWLIST") throw new TypeError("invalid-allowlist-confirmation");
    return Object.freeze({ allowlist: canonicalRoots(value.allowlist), confirmation: value.confirmation });
  }
  throw new TypeError("unknown-control-action");
}

export function makeControlRequest(value, { now = Date.now(), maxAgeMs = BRIDGE_TTL_MS, projectFingerprint } = {}) {
  exactKeys(value, CONTROL_REQUEST_FIELDS, "control-request");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("unsupported-schema-version");
  const action = String(value.action ?? "");
  if (!CONTROL_ACTIONS.includes(action)) throw new TypeError("unknown-control-action");
  const request = Object.freeze({
    schemaVersion: value.schemaVersion,
    requestId: validId(value.requestId, "request-id"),
    projectFingerprint: validHash(value.projectFingerprint, "project-fingerprint"),
    actor: value.actor,
    timestamp: validTimestamp(value.timestamp),
    settingsUpdatedAt: validTimestamp(value.settingsUpdatedAt, "settings-updated-at"),
    settingsVersion: validHash(value.settingsVersion, "settings-version"),
    nonce: validId(value.nonce, "nonce"),
    action,
    payload: controlPayload(action, value.payload),
  });
  if (request.actor !== BRIDGE_ACTOR) throw new TypeError("invalid-bridge-actor");
  if (projectFingerprint && request.projectFingerprint !== projectFingerprint) throw new TypeError("cross-project-request");
  if (request.timestamp > now + 30_000) throw new TypeError("future-request");
  if (now - request.timestamp > maxAgeMs) throw new TypeError("stale-request");
  return request;
}

export function createControlRequest({ controlState, action, payload, timestamp = Date.now(), requestId = randomBytes(16).toString("hex") } = {}) {
  const state = makeControlState(controlState, { now: timestamp });
  return makeControlRequest({
    schemaVersion: SCHEMA_VERSION,
    requestId,
    projectFingerprint: state.projectFingerprint,
    actor: BRIDGE_ACTOR,
    timestamp,
    settingsUpdatedAt: state.settingsUpdatedAt,
    settingsVersion: state.settingsVersion,
    nonce: state.nonce,
    action,
    payload,
  }, { now: timestamp, projectFingerprint: state.projectFingerprint });
}

export function makeControlResponse(value) {
  const normalized = { ...value, reason: value.reason ?? null };
  exactKeys(normalized, CONTROL_RESPONSE_FIELDS, "control-response");
  if (normalized.schemaVersion !== SCHEMA_VERSION) throw new TypeError("unsupported-schema-version");
  const response = Object.freeze({
    schemaVersion: normalized.schemaVersion,
    requestId: validId(normalized.requestId, "request-id"),
    projectFingerprint: validHash(normalized.projectFingerprint, "project-fingerprint"),
    ok: normalized.ok === true,
    status: normalized.status === "accepted" ? "accepted" : normalized.status === "rejected" ? "rejected" : (() => { throw new TypeError("invalid-response-status"); })(),
    processedAt: validTimestamp(normalized.processedAt, "processed-at"),
    reason: normalized.reason === null ? null : String(normalized.reason).slice(0, 256),
  });
  if (response.ok !== (response.status === "accepted")) throw new TypeError("inconsistent-response-status");
  return response;
}

export function makeControlState(value, { now = Date.now(), projectFingerprint } = {}) {
  exactKeys(value, CONTROL_STATE_FIELDS, "control-state");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("unsupported-schema-version");
  const state = Object.freeze({
    schemaVersion: value.schemaVersion,
    projectFingerprint: validHash(value.projectFingerprint, "project-fingerprint"),
    actor: value.actor,
    issuedAt: validTimestamp(value.issuedAt, "issued-at"),
    expiresAt: validTimestamp(value.expiresAt, "expires-at"),
    settingsUpdatedAt: validTimestamp(value.settingsUpdatedAt, "settings-updated-at"),
    settingsVersion: validHash(value.settingsVersion, "settings-version"),
    stateRootIdentity: validHash(value.stateRootIdentity, "state-root-identity"),
    nonce: validId(value.nonce, "nonce"),
    mode: ["manual", "auto", "yolo"].includes(value.mode) ? value.mode : (() => { throw new TypeError("invalid-control-mode"); })(),
    effectiveMode: ["manual", "auto", "yolo"].includes(value.effectiveMode) ? value.effectiveMode : (() => { throw new TypeError("invalid-control-mode"); })(),
    allowedSkillRoots: canonicalRoots(value.allowedSkillRoots),
    consent: Object.freeze((() => {
      exactKeys(value.consent, [...CONSENT_KEYS], "control-consent");
      const result = {};
      for (const key of CONSENT_KEYS) {
        if (typeof value.consent[key] !== "boolean") throw new TypeError("invalid-control-consent");
        result[key] = value.consent[key];
      }
      return result;
    })()),
    repoExcluded: typeof value.repoExcluded === "boolean" ? value.repoExcluded : (() => { throw new TypeError("invalid-control-exclusion"); })(),
  });
  if (state.actor !== BRIDGE_SERVER_ACTOR) throw new TypeError("invalid-control-state-actor");
  if (projectFingerprint && state.projectFingerprint !== projectFingerprint) throw new TypeError("cross-project-control-state");
  if (state.expiresAt <= state.issuedAt || state.expiresAt <= now) throw new TypeError("expired-control-state");
  if (state.issuedAt > now + 30_000) throw new TypeError("future-control-state");
  return state;
}

export function makeTuiHostHealth(value, { now = Date.now(), projectFingerprint, stateRootIdentity } = {}) {
  exactKeys(value, TUI_HOST_HEALTH_FIELDS, "tui-host-health");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("unsupported-schema-version");
  const hostVersion = String(value.hostVersion ?? "");
  if (!HOST_VERSION_PATTERN.test(hostVersion)) throw new TypeError("invalid-host-version");
  const health = Object.freeze({
    schemaVersion: value.schemaVersion,
    projectFingerprint: validHash(value.projectFingerprint, "project-fingerprint"),
    actor: value.actor,
    issuedAt: validTimestamp(value.issuedAt, "issued-at"),
    expiresAt: validTimestamp(value.expiresAt, "expires-at"),
    stateRootIdentity: validHash(value.stateRootIdentity, "state-root-identity"),
    hostVersion,
    publisherPid: Number.isSafeInteger(value.publisherPid) && value.publisherPid > 0
      ? value.publisherPid
      : (() => { throw new TypeError("invalid-tui-host-health-publisher-pid"); })(),
    nonce: validId(value.nonce, "nonce"),
  });
  if (health.actor !== BRIDGE_ACTOR) throw new TypeError("invalid-tui-host-health-actor");
  if (projectFingerprint && health.projectFingerprint !== projectFingerprint) throw new TypeError("cross-project-tui-host-health");
  if (stateRootIdentity && health.stateRootIdentity !== stateRootIdentity) throw new TypeError("state-root-tui-host-health-mismatch");
  if (health.expiresAt <= health.issuedAt || health.expiresAt - health.issuedAt > TUI_HOST_HEALTH_TTL_MS || health.expiresAt <= now) throw new TypeError("expired-tui-host-health");
  if (health.issuedAt > now + 30_000) throw new TypeError("future-tui-host-health");
  return health;
}

export function validateBridgeExportMetadata(type, value, { projectFingerprint, requestId } = {}) {
  let clean;
  if (type === "decision-request") {
    clean = makeBridgeRequest(value, { now: value?.timestamp, maxAgeMs: BRIDGE_TTL_MS, projectFingerprint });
  } else if (type === "decision-response") {
    clean = makeBridgeResponse(value);
  } else if (type === "control-request") {
    clean = makeControlRequest(value, { now: value?.timestamp, maxAgeMs: BRIDGE_TTL_MS, projectFingerprint });
  } else if (type === "control-response") {
    clean = makeControlResponse(value);
  } else if (type === "control-state") {
    clean = makeControlState(value, { now: value?.issuedAt, projectFingerprint });
  } else if (type === "operation-request") {
    clean = validateOperationRequestEnvelope(value, {
      now: value?.issuedAt,
      projectFingerprint,
    });
  } else if (type === "operation-response") {
    clean = makeUiOperationResponse(value, {
      projectFingerprint,
      stateRootIdentity: value?.stateRootIdentity,
      requestId: value?.requestId,
      action: value?.action,
      requestHash: value?.requestHash,
      requestIssuedAt: Math.min(value?.processedAt ?? 0, value?.processedAt ?? 0),
      requestExpiresAt: (value?.processedAt ?? 0) + UI_PROTOCOL_LIMITS.operationTtlMs,
      now: value?.processedAt,
    });
  } else {
    throw new TypeError("unknown-bridge-export-class");
  }
  if (clean.projectFingerprint !== projectFingerprint) throw new TypeError("cross-project-bridge-export");
  if (requestId !== undefined && clean.requestId !== requestId) throw new TypeError("request-id-path-mismatch");
  return clean;
}

export function createDecisionRequest({
  projectFingerprint,
  proposal,
  newState,
  feedback,
  actor = BRIDGE_ACTOR,
  timestamp = Date.now(),
  requestId = randomBytes(16).toString("hex"),
} = {}) {
  return makeBridgeRequest({
    schemaVersion: SCHEMA_VERSION,
    requestId,
    projectFingerprint,
    proposalId: proposal?.id,
    targetHash: proposal?.skillTarget?.currentHash,
    proposedContentHash: proposal?.proposedContentHash,
    decisionVersion: proposal?.decisionVersion + 1,
    priorState: proposal?.state,
    newState,
    actor,
    timestamp,
    nonce: proposal?.decisionNonce,
    ...(feedback === undefined ? {} : {
      feedbackVersion: DECISION_FEEDBACK_VERSION,
      feedback: {
        reason: feedback?.reason,
        text: feedback?.text ?? null,
      },
    }),
  }, { now: timestamp, projectFingerprint });
}

export function submitDecisionRequest(stateRoot, request) {
  const clean = makeBridgeRequest(request, { now: Date.now(), projectFingerprint: request.projectFingerprint });
  const source = boundedJson(clean, MAX_REQUEST_BYTES, "bridge-request");
  const boundary = stateBoundary(stateRoot);
  return withStateMutationLock(boundary, () => {
    const paths = bridgePaths(boundary, clean.projectFingerprint, { create: true });
    const target = path.join(paths.requests, `${clean.requestId}.json`);
    assertMailboxPublication(paths, target, source, { request: true });
    atomicWrite(paths, target, source, { exclusive: true });
    return { ok: true, requestId: clean.requestId, path: target };
  });
}

export function submitControlRequest(stateRoot, request) {
  const clean = makeControlRequest(request, { now: Date.now(), projectFingerprint: request.projectFingerprint });
  const source = boundedJson(clean, MAX_REQUEST_BYTES, "control-request");
  const boundary = stateBoundary(stateRoot);
  return withStateMutationLock(boundary, () => {
    const paths = bridgePaths(boundary, clean.projectFingerprint, { create: true });
    const target = path.join(paths.controlRequests, `${clean.requestId}.json`);
    assertMailboxPublication(paths, target, source, { request: true });
    atomicWrite(paths, target, source, { exclusive: true });
    return { ok: true, requestId: clean.requestId, path: target };
  });
}

function operationRequestContext(value, nowValue = Date.now()) {
  return {
    projectFingerprint: value?.projectFingerprint,
    stateRootIdentity: value?.stateRootIdentity,
    generation: value?.generation,
    projectionHash: value?.projectionHash,
    now: nowValue,
    supportedCapabilities: UI_CAPABILITIES,
    grant: {
      action: value?.action,
      capability: value?.capability,
      nonce: value?.nonce,
      expiresAt: value?.expiresAt,
    },
  };
}

function validateOperationRequestEnvelope(value, { now = Date.now(), projectFingerprint } = {}) {
  const clean = makeUiOperationRequest(value, operationRequestContext(value, now));
  if (projectFingerprint && clean.projectFingerprint !== projectFingerprint) throw new TypeError("cross-project-request");
  return clean;
}

export function createUiOperationRequest({
  projection,
  grant,
  action = grant?.action,
  payload,
  timestamp = Date.now(),
  requestId = randomBytes(16).toString("hex"),
} = {}) {
  const expiresAt = Math.min(timestamp + UI_PROTOCOL_LIMITS.operationTtlMs, grant?.expiresAt ?? 0);
  const body = {
    operationProtocolVersion: UI_OPERATION_PROTOCOL_VERSION,
    requestId,
    projectFingerprint: projection?.projectFingerprint,
    stateRootIdentity: projection?.stateRootIdentity,
    generation: projection?.generation,
    projectionHash: projection?.projectionHash,
    action,
    capability: grant?.capability,
    actor: BRIDGE_ACTOR,
    issuedAt: timestamp,
    expiresAt,
    nonce: grant?.nonce,
    payload,
  };
  const request = { ...body, operationHash: hashUiProtocol("operation-request", body) };
  return makeUiOperationRequest(request, {
    projectFingerprint: projection?.projectFingerprint,
    stateRootIdentity: projection?.stateRootIdentity,
    generation: projection?.generation,
    projectionHash: projection?.projectionHash,
    now: timestamp,
    supportedCapabilities: projection?.capabilities ?? UI_CAPABILITIES,
    grant,
  });
}

export function submitUiOperationRequest(stateRoot, request) {
  const clean = validateOperationRequestEnvelope(request, {
    now: request?.issuedAt,
    projectFingerprint: request?.projectFingerprint,
  });
  const source = boundedJson(clean, UI_PROTOCOL_LIMITS.operationBytes, "operation-request");
  const boundary = stateBoundary(stateRoot);
  return withStateMutationLock(boundary, () => {
    const paths = bridgePaths(boundary, clean.projectFingerprint, { create: true });
    const target = path.join(paths.operationRequests, `${clean.requestId}.json`);
    if (lstatOptional(path.join(paths.operationResponses, `${clean.requestId}.json`))) {
      throw new Error("operation-response-already-exists");
    }
    assertMailboxPublication(paths, target, source, { request: true });
    atomicWrite(paths, target, source, { exclusive: true });
    return { ok: true, requestId: clean.requestId, path: target };
  });
}

function pollResponse(stateRoot, projectFingerprint, requestId, type) {
  const paths = bridgePaths(stateRoot, projectFingerprint);
  if (!paths) return null;
  const id = validId(requestId, "request-id");
  const directory = type === "control" ? paths.controlResponses : paths.responses;
  const filePath = path.join(directory, `${id}.json`);
  let read;
  try { read = secureRead(paths, filePath, MAX_RESPONSE_BYTES, `${type}-response`); }
  catch (error) { if (/hardlink-rejected$/u.test(errorReasonCode(error, "bridge-error"))) return null; throw error; }
  if (!read) return null;
  const response = type === "control" ? makeControlResponse(JSON.parse(read.source)) : makeBridgeResponse(JSON.parse(read.source));
  if (response.projectFingerprint !== projectFingerprint || response.requestId !== id) throw new Error("cross-project-response");
  return response;
}

export function pollDecisionResponse(stateRoot, projectFingerprint, requestId) {
  return pollResponse(stateRoot, projectFingerprint, requestId, "decision");
}

export function pollControlResponse(stateRoot, projectFingerprint, requestId) {
  return pollResponse(stateRoot, projectFingerprint, requestId, "control");
}

export function pollUiOperationResponse(stateRoot, request, { now = Date.now() } = {}) {
  const cleanRequest = validateOperationRequestEnvelope(request, {
    now: Math.min(now, request?.expiresAt - 1),
    projectFingerprint: request?.projectFingerprint,
  });
  const paths = bridgePaths(stateRoot, cleanRequest.projectFingerprint);
  if (!paths) return null;
  const filePath = path.join(paths.operationResponses, `${cleanRequest.requestId}.json`);
  const read = secureRead(paths, filePath, UI_PROTOCOL_LIMITS.responseBytes, "operation-response");
  if (!read) return null;
  return makeUiOperationResponse(JSON.parse(read.source), {
    projectFingerprint: cleanRequest.projectFingerprint,
    stateRootIdentity: cleanRequest.stateRootIdentity,
    requestId: cleanRequest.requestId,
    action: cleanRequest.action,
    requestHash: cleanRequest.operationHash,
    requestIssuedAt: cleanRequest.issuedAt,
    requestExpiresAt: cleanRequest.expiresAt,
    now,
  });
}

export function publishControlState(stateRoot, value) {
  const clean = makeControlState(value, { now: value.issuedAt, projectFingerprint: value.projectFingerprint });
  const source = boundedJson(clean, MAX_CONTROL_STATE_BYTES, "control-state");
  const boundary = stateBoundary(stateRoot);
  return withStateMutationLock(boundary, () => {
    const paths = bridgePaths(boundary, clean.projectFingerprint, { create: true });
    assertMailboxPublication(paths, paths.controlState, source);
    atomicWrite(paths, paths.controlState, source);
    return clean;
  });
}

export function readControlState(stateRoot, projectFingerprint, { now = Date.now() } = {}) {
  const paths = bridgePaths(stateRoot, projectFingerprint);
  if (!paths) return null;
  const read = secureRead(paths, paths.controlState, MAX_CONTROL_STATE_BYTES, "control-state");
  if (!read) return null;
  return makeControlState(JSON.parse(read.source), { now, projectFingerprint });
}

function validateUiProjectionBundle({
  index: indexValue,
  details: detailValues,
  dashboard: dashboardValue,
  offer: offerValue,
  projectFingerprint,
  stateRootIdentity,
  now,
}) {
  const offer = makeUiProtocolOffer(offerValue ?? {
    projectionVersions: [UI_PROJECTION_VERSION],
    operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
    capabilities: UI_CAPABILITIES,
  });
  if (!offer.projectionVersions.includes(UI_PROJECTION_VERSION)) throw new Error("ui-projection-version-not-offered");
  const index = makeUiProjectionIndex(indexValue, {
    projectFingerprint,
    stateRootIdentity,
    generation: indexValue?.generation,
    now,
    supportedCapabilities: offer.capabilities,
  });
  if (index.capabilities.some((capability) => !offer.capabilities.includes(capability))) {
    throw new Error("ui-projection-capability-not-offered");
  }
  if (!Array.isArray(detailValues) || detailValues.length !== index.reviews.length) {
    throw new Error("ui-projection-detail-set-incomplete");
  }
  const reviews = new Map(index.reviews.map((review) => [review.proposalId, review]));
  const seen = new Set();
  const details = detailValues.map((value) => {
    const review = reviews.get(value?.proposalId);
    if (!review || seen.has(value.proposalId)) throw new Error("ui-projection-detail-set-mismatch");
    const detail = makeUiReviewDetail(value, {
      projectFingerprint,
      stateRootIdentity,
      generation: index.generation,
      detailRevision: review.detailRevision,
      detailHash: review.detailHash,
      now,
      supportedCapabilities: index.capabilities,
    });
    if (detail.summary.state !== review.state || detail.summary.target.relativePath !== review.target) {
      throw new Error("ui-projection-detail-index-mismatch");
    }
    if (detail.issuedAt < index.issuedAt || detail.expiresAt > index.expiresAt) {
      throw new Error("ui-projection-detail-lifetime-mismatch");
    }
    seen.add(detail.proposalId);
    return detail;
  }).sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  if (seen.size !== reviews.size) throw new Error("ui-projection-detail-set-incomplete");
  const dashboard = dashboardValue === undefined || dashboardValue === null
    ? null
    : makeUiDashboard(dashboardValue, {
        projectFingerprint,
        stateRootIdentity,
        generation: index.generation,
        indexHash: index.projectionHash,
        now,
      });
  return Object.freeze({ offer, index, details: Object.freeze(details), dashboard });
}

function cleanupStaleUiGenerationsUnlocked(paths, activeGeneration) {
  const projection = uiProjectionPaths(paths);
  if (!projection) return 0;
  assertPrivateProjectionTree(paths, projection.root);
  let removed = 0;
  for (const entry of readdirSync(projection.generations, { withFileTypes: true })) {
    const entryPath = path.join(projection.generations, entry.name);
    if (entry.name === activeGeneration) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !HASH_PATTERN.test(entry.name)) {
      removed += removePrivateProjectionTree(paths, entryPath);
      continue;
    }
    removed += removePrivateProjectionTree(paths, entryPath);
  }
  return removed;
}

function cleanupUiProjectionTempsUnlocked(paths, directory) {
  const root = lstatOptional(directory);
  if (!root) return 0;
  assertPrivateProjectionTree(paths, directory);
  let removed = 0;
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
      const stat = lstatSync(filePath);
      if (secureUnlink(paths, filePath, stat)) removed += 1;
    }
  };
  visit(directory);
  return removed;
}

export function publishUiProjection(stateRoot, {
  index,
  details,
  dashboard,
  offer,
  now = Date.now(),
  __testFaultInjection,
} = {}) {
  const boundary = stateBoundary(stateRoot);
  assertUiProjectionBoundary(boundary);
  const projectFingerprint = validHash(index?.projectFingerprint, "project-fingerprint");
  const expectedRootIdentity = computeStateRootIdentity(boundary);
  const clean = validateUiProjectionBundle({
    index,
    details,
    dashboard,
    offer,
    projectFingerprint,
    stateRootIdentity: expectedRootIdentity,
    now,
  });
  return withStateMutationLock(boundary, () => {
    const paths = bridgePaths(boundary, projectFingerprint, { create: true });
    assertPrivateProjectionAncestors(paths, paths.root);
    const projection = uiProjectionPaths(paths, { create: true, generation: clean.index.generation });
    assertPrivateProjectionTree(paths, projection.root);
    let removed = cleanupUiProjectionTempsUnlocked(paths, projection.root);
    const offerSource = boundedJson(clean.offer, MAX_REQUEST_BYTES, "ui-protocol-offer");
    const indexSource = boundedJson(clean.index, UI_PROTOCOL_LIMITS.indexBytes, "ui-projection-index");
    const dashboardSource = clean.dashboard
      ? boundedJson(clean.dashboard, UI_PROTOCOL_LIMITS.dashboardBytes, "ui-dashboard")
      : null;
    const detailSources = new Map(clean.details.map((detail) => [
      projectionDetailPath(projection, detail.proposalId),
      boundedJson(detail, UI_PROTOCOL_LIMITS.detailBytes, "ui-review-detail"),
    ]));
    const planned = new Map([
      [projection.offer, offerSource],
      [projection.index, indexSource],
      ...(dashboardSource ? [[projection.dashboard, dashboardSource]] : []),
      ...detailSources,
    ]);
    assertUiProjectionPublication(paths, planned);
    for (const [filePath, source] of detailSources) atomicWrite(paths, filePath, source);
    __testFaultInjection?.("ui-projection-after-details", { generation: clean.index.generation });
    if (dashboardSource) atomicWrite(paths, projection.dashboard, dashboardSource);
    __testFaultInjection?.("ui-projection-after-dashboard", { generation: clean.index.generation });
    atomicWrite(paths, projection.offer, offerSource);
    __testFaultInjection?.("ui-projection-before-index", { generation: clean.index.generation });
    atomicWrite(paths, projection.index, indexSource);
    __testFaultInjection?.("ui-projection-after-index", { generation: clean.index.generation });
    removed += cleanupStaleUiGenerationsUnlocked(paths, clean.index.generation);
    return Object.freeze({
      offer: clean.offer,
      index: clean.index,
      details: clean.details,
      dashboard: clean.dashboard,
      staleFilesRemoved: removed,
    });
  });
}

export function readUiProjection(stateRoot, projectFingerprint, {
  now = Date.now(),
  stateRootIdentity,
  clientOffer,
  detailProposalIds = [],
  __testEffectiveUid,
  __testAfterIndexRead,
  __testAfterDetailsRead,
} = {}) {
  const fingerprint = validHash(projectFingerprint, "project-fingerprint");
  const boundary = stateBoundary(stateRoot);
  const expectedRootIdentity = stateRootIdentity ?? computeStateRootIdentity(boundary);
  const paths = bridgePaths(boundary, fingerprint);
  const legacy = (reasonValue) => Object.freeze({
    ...negotiateUiProtocol(null, clientOffer),
    reason: reasonValue,
    index: null,
    dashboard: null,
    dashboardError: null,
    details: Object.freeze([]),
    effectiveIndexActions: Object.freeze([]),
    effectiveDetailActions: Object.freeze({}),
  });
  if (!paths) return legacy("server-bridge-unavailable");
  const projection = uiProjectionPaths(paths);
  if (!projection) return legacy("server-offer-unavailable");
  const offerRead = secureProjectionRead(paths, projection.offer, MAX_REQUEST_BYTES, "ui-protocol-offer", {
    effectiveUid: __testEffectiveUid,
  });
  if (!offerRead) return legacy("server-offer-unavailable");
  const serverOffer = makeUiProtocolOffer(JSON.parse(offerRead.source));
  const negotiation = negotiateUiProtocol(serverOffer, clientOffer);
  if (negotiation.mode === "legacy") {
    return Object.freeze({
      ...negotiation,
      index: null,
      dashboard: null,
      dashboardError: null,
      details: Object.freeze([]),
      effectiveIndexActions: Object.freeze([]),
      effectiveDetailActions: Object.freeze({}),
    });
  }
  const indexRead = secureProjectionRead(paths, projection.index, UI_PROTOCOL_LIMITS.indexBytes, "ui-projection-index", {
    effectiveUid: __testEffectiveUid,
  });
  if (!indexRead) throw new Error("ui-projection-index-unavailable");
  const indexValue = JSON.parse(indexRead.source);
  const index = makeUiProjectionIndex(indexValue, {
    projectFingerprint: fingerprint,
    stateRootIdentity: expectedRootIdentity,
    generation: indexValue?.generation,
    now,
    supportedCapabilities: serverOffer.capabilities,
  });
  __testAfterIndexRead?.({ index });
  if (!Array.isArray(detailProposalIds)
      || detailProposalIds.length > UI_PROTOCOL_LIMITS.residentDetails
      || new Set(detailProposalIds).size !== detailProposalIds.length) {
    throw new TypeError("resident-details-out-of-bounds");
  }
  const reviews = new Map(index.reviews.map((review) => [review.proposalId, review]));
  const generationPaths = uiProjectionPaths(paths, { generation: index.generation });
  if (!generationPaths) throw new Error("ui-projection-generation-unavailable");
  let dashboard = null;
  let dashboardError = null;
  let dashboardRead = null;
  try {
    dashboardRead = secureProjectionRead(
      paths,
      generationPaths.dashboard,
      UI_PROTOCOL_LIMITS.dashboardBytes,
      "ui-dashboard",
      { effectiveUid: __testEffectiveUid },
    );
    if (dashboardRead) {
      dashboard = makeUiDashboard(JSON.parse(dashboardRead.source), {
        projectFingerprint: fingerprint,
        stateRootIdentity: expectedRootIdentity,
        generation: index.generation,
        indexHash: index.projectionHash,
        now,
      });
    }
  } catch (error) {
    const code = errorReasonCode(error, "ui-dashboard-malformed");
    if (/owner|permissions|symlink|hardlink|replaced|path-rejected/u.test(code)) throw error;
    dashboardError = code || "ui-dashboard-malformed";
  }
  const details = detailProposalIds.map((proposalId) => {
    const review = reviews.get(proposalId);
    if (!review) throw new Error("ui-projection-detail-unlisted");
    const detailPath = projectionDetailPath(generationPaths, proposalId);
    const read = secureProjectionRead(paths, detailPath, UI_PROTOCOL_LIMITS.detailBytes, "ui-review-detail", {
      effectiveUid: __testEffectiveUid,
    });
    if (!read) throw new Error("ui-projection-detail-unavailable");
    const detail = makeUiReviewDetail(JSON.parse(read.source), {
      projectFingerprint: fingerprint,
      stateRootIdentity: expectedRootIdentity,
      generation: index.generation,
      detailRevision: review.detailRevision,
      detailHash: review.detailHash,
      now,
      supportedCapabilities: index.capabilities,
    });
    if (detail.summary.state !== review.state || detail.summary.target.relativePath !== review.target) {
      throw new Error("ui-projection-detail-index-mismatch");
    }
    return detail;
  });
  __testAfterDetailsRead?.({ index, details, dashboard, dashboardError });
  const indexReadback = secureProjectionRead(paths, projection.index, UI_PROTOCOL_LIMITS.indexBytes, "ui-projection-index", {
    effectiveUid: __testEffectiveUid,
  });
  if (!indexReadback
      || !sameInode(indexRead.stat, indexReadback.stat)
      || indexRead.source !== indexReadback.source) {
    throw new Error("ui-projection-index-replaced");
  }
  const offerReadback = secureProjectionRead(paths, projection.offer, MAX_REQUEST_BYTES, "ui-protocol-offer", {
    effectiveUid: __testEffectiveUid,
  });
  if (!offerReadback
      || !sameInode(offerRead.stat, offerReadback.stat)
      || offerRead.source !== offerReadback.source) {
    throw new Error("ui-protocol-offer-replaced");
  }
  if (dashboard && dashboardRead) {
    const dashboardReadback = secureProjectionRead(
      paths,
      generationPaths.dashboard,
      UI_PROTOCOL_LIMITS.dashboardBytes,
      "ui-dashboard",
      { effectiveUid: __testEffectiveUid },
    );
    if (!dashboardReadback
        || !sameInode(dashboardRead.stat, dashboardReadback.stat)
        || dashboardRead.source !== dashboardReadback.source) {
      throw new Error("ui-dashboard-replaced");
    }
  }
  const effectiveCapabilities = new Set(negotiation.capabilities);
  const effectiveDetailActions = Object.fromEntries(details.map((detail) => [
    detail.proposalId,
    Object.freeze(detail.allowedActions.filter((action) => effectiveCapabilities.has(action.capability))),
  ]));
  return Object.freeze({
    ...negotiation,
    index,
    dashboard,
    dashboardError,
    details: Object.freeze(details),
    effectiveIndexActions: Object.freeze(index.allowedActions.filter((action) => effectiveCapabilities.has(action.capability))),
    effectiveDetailActions: Object.freeze(effectiveDetailActions),
  });
}

export function publishTuiHostHealth(stateRoot, {
  projectFingerprint,
  stateRootIdentity,
  hostVersion,
  publisherPid = process.pid,
  issuedAt = Date.now(),
  expiresAt = issuedAt + TUI_HOST_HEALTH_TTL_MS,
  nonce = randomBytes(16).toString("hex"),
} = {}) {
  const clean = makeTuiHostHealth({
    schemaVersion: SCHEMA_VERSION,
    projectFingerprint,
    actor: BRIDGE_ACTOR,
    issuedAt,
    expiresAt,
    stateRootIdentity,
    hostVersion,
    publisherPid,
    nonce,
  }, { now: issuedAt, projectFingerprint, stateRootIdentity });
  const source = boundedJson(clean, MAX_RESPONSE_BYTES, "tui-host-health");
  const boundary = stateBoundary(stateRoot);
  return withStateMutationLock(boundary, () => {
    const paths = bridgePaths(boundary, clean.projectFingerprint, { create: true });
    const uid = effectiveUserId();
    assertTuiHostHealthAncestors(paths, uid);
    assertMailboxPublication(paths, paths.tuiHostHealth, source);
    atomicWrite(paths, paths.tuiHostHealth, source);
    const published = lstatSync(paths.tuiHostHealth);
    if (published.uid !== uid) throw new Error("tui-host-health-file-owner-rejected");
    if ((published.mode & 0o777) !== FILE_MODE) throw new Error("tui-host-health-mode-rejected");
    assertTuiHostHealthAncestors(paths, uid);
    return clean;
  });
}

export function readTuiHostHealth(stateRoot, projectFingerprint, {
  now = Date.now(),
  stateRootIdentity,
  requireLivePublisher = true,
  __testEffectiveUid,
  __testSignalProcess,
} = {}) {
  const paths = bridgePaths(stateRoot, projectFingerprint);
  if (!paths) return null;
  const read = secureReadTuiHostHealth(paths, { effectiveUid: __testEffectiveUid });
  if (!read) return null;
  const health = makeTuiHostHealth(JSON.parse(read.source), { now, projectFingerprint, stateRootIdentity });
  if (requireLivePublisher && !sameAccountProcessIsAlive(health.publisherPid, __testSignalProcess)) throw new Error("stale-tui-host-health-publisher");
  return health;
}

export function revokeTuiHostHealth(stateRoot, projectFingerprint, { nonce, stateRootIdentity } = {}) {
  const paths = bridgePaths(stateRoot, projectFingerprint);
  if (!paths) return false;
  const expectedNonce = validId(nonce, "nonce");
  return withStateMutationLock(paths.boundary, () => {
    const read = secureReadTuiHostHealth(paths);
    if (!read) return false;
    const value = JSON.parse(read.source);
    const health = makeTuiHostHealth(value, {
      now: value?.issuedAt,
      projectFingerprint,
      stateRootIdentity,
    });
    if (health.nonce !== expectedNonce) return false;
    return secureUnlink(paths, paths.tuiHostHealth, read.stat);
  });
}

function readJsonl(paths, filePath) {
  const read = secureRead(paths, filePath, MAX_RECORD_FILE_BYTES, "project-record");
  if (!read) return [];
  const records = [];
  for (const line of read.source.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { throw new Error("corrupt-project-record"); }
  }
  return records;
}

function contentFor(proposal, records) {
  const chunks = records.filter((record) => record?.kind === "proposal-content")
    .map((record) => assertRecord(record).payload)
    .filter((chunk) => chunk.proposalId === proposal.id)
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (!chunks.length || chunks.some((chunk) => chunk.contentHash !== proposal.proposedContentHash)) return undefined;
  if (chunks.some((chunk, index) => chunk.chunkIndex !== index || chunk.chunkCount !== chunks.length || chunk.contentEncoding !== "base64")) return undefined;
  const encoded = chunks.map((chunk) => chunk.content).join("");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return undefined;
  const content = decoded.toString("utf8");
  return createHash("sha256").update(content).digest("hex") === proposal.proposedContentHash ? content : undefined;
}

export function readProjectInbox(stateRoot, projectFingerprint, { now = Date.now() } = {}) {
  const fingerprint = validHash(projectFingerprint, "project-fingerprint");
  const boundary = stateBoundary(stateRoot);
  const stateDir = walkDirectories(boundary, ["self-evolve", fingerprint]);
  if (!stateDir) return [];
  const paths = { boundary };
  const proposals = readJsonl(paths, path.join(stateDir, "proposals.jsonl"));
  const audit = readJsonl(paths, path.join(stateDir, "audit.jsonl"));
  const latest = new Map();
  for (const record of proposals) {
    if (record?.kind !== "proposal") continue;
    const proposal = makeProposal(record.payload);
    if (proposal.projectFingerprint !== fingerprint) throw new Error("cross-project-proposal");
    latest.set(proposal.id, proposal);
  }
  const grants = new Map();
  for (const record of audit) {
    const event = record?.payload;
    const details = event?.details;
    if (details?.action !== "bridge-nonce" || event?.proposalId === undefined) continue;
    if (details.projectFingerprint !== fingerprint || details.actor !== BRIDGE_ACTOR || !ID_PATTERN.test(String(details.nonce ?? ""))) continue;
    if (!Number.isSafeInteger(details.expiresAt) || details.expiresAt <= now) continue;
    grants.set(event.proposalId, details);
  }
  return [...latest.values()].filter((proposal) => ["pending", "applied", "failed-closed"].includes(proposal.state)).map((proposal) => {
    const grant = grants.get(proposal.id);
    const matches = grant
      && grant.targetHash === proposal.skillTarget.currentHash
      && grant.proposedContentHash === proposal.proposedContentHash
      && grant.decisionVersion === proposal.decisionVersion + 1
      && grant.priorState === proposal.state;
    const content = contentFor(proposal, proposals);
    const snooze = audit.map((record) => record.payload).findLast((event) => event?.proposalId === proposal.id && event.details?.action === "snooze");
    return {
      ...proposal,
      ...(matches ? { decisionNonce: grant.nonce, decisionNonceExpiresAt: grant.expiresAt } : {}),
      ...(content === undefined ? {} : { proposedContent: content }),
      ...(Number.isSafeInteger(snooze?.details?.snoozedUntil) ? { snoozedUntil: snooze.details.snoozedUntil } : {}),
    };
  });
}

export function readBoundedInspection(stateRoot, projectFingerprint, { limit = 32 } = {}) {
  const fingerprint = validHash(projectFingerprint, "project-fingerprint");
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64) throw new TypeError("inspection-limit-out-of-bounds");
  const boundary = stateBoundary(stateRoot);
  const stateDir = walkDirectories(boundary, ["self-evolve", fingerprint]);
  if (!stateDir) return Object.freeze({
    observations: Object.freeze([]),
    eligibility: Object.freeze([]),
    overflow: Object.freeze({ observations: 0, eligibility: 0 }),
  });
  const paths = { boundary };
  const records = [
    ...readJsonl(paths, path.join(stateDir, "observations.jsonl")),
    ...readJsonl(paths, path.join(stateDir, "proposals.jsonl")),
  ].map(assertRecord);
  const observations = records
    .filter((record) => record.kind === "observation" && record.payload.projectFingerprint === fingerprint)
    .map((record) => ({
      occurredAt: record.payload.createdAt,
      redacted: record.payload.redacted,
      injectionFlagged: record.payload.injectionFlagged,
      summary: Object.entries(record.payload.structuredFields)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ")
        .slice(0, 2_048) || "Sanitized observation with no structured summary fields.",
    }))
    .sort((left, right) => right.occurredAt - left.occurredAt);
  const eligibility = records
    .filter((record) => record.kind === "eligibility-explanation")
    .map((record) => ({
      eligible: record.payload.eligible,
      reasons: record.payload.reasons,
      met: record.payload.thresholdsMet,
      missed: record.payload.thresholdsMissed,
    }));
  return Object.freeze({
    observations: Object.freeze(observations.slice(0, limit).map(Object.freeze)),
    eligibility: Object.freeze((limit > 0 ? eligibility.slice(-limit) : []).reverse().map(Object.freeze)),
    overflow: Object.freeze({
      observations: Math.max(0, observations.length - limit),
      eligibility: Math.max(0, eligibility.length - limit),
    }),
  });
}

function acquireConsumerLock(paths, now, ttlMs) {
  const lease = { pid: process.pid, acquiredAt: now, expiresAt: now + ttlMs, nonce: randomBytes(16).toString("hex") };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      atomicWrite(paths, paths.lock, boundedJson(lease, 1024, "bridge-lock"), { exclusive: true });
      return lease;
    } catch (error) {
      if (error?.code !== "EEXIST" && errorReasonCode(error, "bridge-error") !== "bridge-file-exists") return null;
      try {
        const read = secureRead(paths, paths.lock, 1024, "bridge-lock");
        const current = JSON.parse(read.source);
        if (current.expiresAt > now || processIsAlive(current.pid)) return null;
        const stalePath = `${paths.lock}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
        revalidateDirectory(paths.boundary, paths.root);
        renameSync(paths.lock, stalePath);
        const recovered = secureRead(paths, stalePath, 1024, "bridge-lock");
        if (JSON.parse(recovered.source).nonce !== current.nonce) {
          if (!lstatOptional(paths.lock)) renameSync(stalePath, paths.lock);
          return null;
        }
        secureUnlink(paths, stalePath, recovered.stat);
      } catch {
        const current = lstatOptional(paths.lock);
        if (!current || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || now - current.mtimeMs < ttlMs) return null;
        try {
          const stalePath = `${paths.lock}.malformed.${process.pid}.${randomBytes(8).toString("hex")}`;
          revalidateDirectory(paths.boundary, paths.root);
          renameSync(paths.lock, stalePath);
          const moved = lstatSync(stalePath);
          secureUnlink(paths, stalePath, moved);
        } catch { return null; }
      }
    }
  }
  return null;
}

function releaseConsumerLock(paths, nonce) {
  const read = secureRead(paths, paths.lock, 1024, "bridge-lock");
  if (!read) return;
  if (JSON.parse(read.source).nonce === nonce) secureUnlink(paths, paths.lock, read.stat);
}

function requestFiles(paths, directory) {
  revalidateDirectory(paths.boundary, directory);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json") && ID_PATTERN.test(entry.name.slice(0, -5)))
    .map((entry) => ({ requestId: entry.name.slice(0, -5), filePath: path.join(directory, entry.name) }))
    .sort((left, right) => left.requestId.localeCompare(right.requestId));
}

export function pendingRequestCounts(stateRoot, projectFingerprint) {
  const paths = bridgePaths(stateRoot, projectFingerprint, { create: true });
  return {
    decisions: requestFiles(paths, paths.requests).length,
    controls: requestFiles(paths, paths.controlRequests).length,
    operations: requestFiles(paths, paths.operationRequests).length,
  };
}

async function consumeType({ paths, projectFingerprint, now, maxRequests, type, handler, beforeRead, afterHandled }) {
  const directory = type === "control" ? paths.controlRequests : paths.requests;
  const responseDirectory = type === "control" ? paths.controlResponses : paths.responses;
  const processed = [];
  if (typeof handler !== "function") return processed;
  for (const item of requestFiles(paths, directory).slice(0, maxRequests)) {
    let request;
    let result;
    let read;
    try {
      beforeRead?.({ type, filePath: item.filePath, requestId: item.requestId });
      read = secureRead(paths, item.filePath, MAX_REQUEST_BYTES, `${type}-request`);
      if (!read) continue;
      request = type === "control"
        ? makeControlRequest(JSON.parse(read.source), { now: now(), projectFingerprint })
        : makeBridgeRequest(JSON.parse(read.source), { now: now(), projectFingerprint });
      if (request.requestId !== item.requestId) throw new Error("request-id-path-mismatch");
      result = await handler(request);
    } catch (error) {
      result = { ok: false, reason: errorReasonCode(error, "bridge-error") };
    }
    await afterHandled?.({ type, request, result, filePath: item.filePath, requestId: item.requestId });
    const common = {
      schemaVersion: SCHEMA_VERSION,
      requestId: item.requestId,
      projectFingerprint,
      ok: result?.ok === true,
      status: result?.ok === true ? "accepted" : "rejected",
      processedAt: now(),
      reason: result?.ok === true ? null : String(result?.reason ?? `${type}-rejected`),
    };
    const response = type === "control"
      ? makeControlResponse(common)
      : makeBridgeResponse({ ...common, proposalId: request?.proposalId ?? "invalid-request", recovered: result?.recovered === true });
    const responsePath = path.join(responseDirectory, `${item.requestId}.json`);
    const responseSource = boundedJson(response, MAX_RESPONSE_BYTES, `${type}-response`);
    withStateMutationLock(paths.boundary, () => {
      const current = lstatOptional(item.filePath);
      if (current && (!read || !sameInode(current, read.stat))) throw new Error(`${type}-request-replaced`);
      if (!lstatOptional(responsePath)) {
        assertMailboxPublication(paths, responsePath, responseSource, { removePath: current ? item.filePath : undefined });
        atomicWrite(paths, responsePath, responseSource, { exclusive: true });
      }
      if (current) secureUnlink(paths, item.filePath, read.stat);
    });
    processed.push(response);
  }
  return processed;
}

async function consumeOperationType({
  paths,
  projectFingerprint,
  now,
  maxRequests,
  handler,
  beforeRead,
  afterHandled,
}) {
  const processed = [];
  if (typeof handler !== "function") return processed;
  for (const item of requestFiles(paths, paths.operationRequests).slice(0, maxRequests)) {
    let read;
    let request;
    let result;
    try {
      beforeRead?.({ type: "operation", filePath: item.filePath, requestId: item.requestId });
      read = secureRead(paths, item.filePath, UI_PROTOCOL_LIMITS.operationBytes, "operation-request");
      if (!read) continue;
      const value = JSON.parse(read.source);
      request = validateOperationRequestEnvelope(value, { now: now(), projectFingerprint });
      if (request.requestId !== item.requestId) throw new Error("request-id-path-mismatch");
      result = await handler(request);
    } catch (error) {
      result = { ok: false, reason: errorReasonCode(error, "bridge-error") };
    }
    await afterHandled?.({
      type: "operation",
      request,
      result,
      filePath: item.filePath,
      requestId: item.requestId,
    });
    let response;
    if (request) {
      const processedAt = Math.max(request.issuedAt, Math.min(now(), request.expiresAt - 1));
      const status = result?.ok === true
        ? result?.terminal === true ? "accepted-terminal" : "accepted"
        : "rejected";
      const body = {
        operationProtocolVersion: UI_OPERATION_PROTOCOL_VERSION,
        requestId: request.requestId,
        projectFingerprint,
        stateRootIdentity: request.stateRootIdentity,
        action: request.action,
        requestHash: request.operationHash,
        ok: result?.ok === true,
        status,
        processedAt,
        reason: result?.ok === true ? null : String(result?.reason ?? "operation-rejected").slice(0, UI_PROTOCOL_LIMITS.reasonBytes),
      };
      response = makeUiOperationResponse({
        ...body,
        responseHash: hashUiProtocol("operation-response", body),
      }, {
        projectFingerprint,
        stateRootIdentity: request.stateRootIdentity,
        requestId: request.requestId,
        action: request.action,
        requestHash: request.operationHash,
        requestIssuedAt: request.issuedAt,
        requestExpiresAt: request.expiresAt,
        now: processedAt,
      });
    }
    withStateMutationLock(paths.boundary, () => {
      const current = lstatOptional(item.filePath);
      if (current && (!read || !sameInode(current, read.stat))) throw new Error("operation-request-replaced");
      if (response) {
        const responsePath = path.join(paths.operationResponses, `${item.requestId}.json`);
        const source = boundedJson(response, UI_PROTOCOL_LIMITS.responseBytes, "operation-response");
        if (!lstatOptional(responsePath)) {
          assertMailboxPublication(paths, responsePath, source, {
            removePath: current ? item.filePath : undefined,
          });
          atomicWrite(paths, responsePath, source, { exclusive: true });
        }
      }
      if (current) secureUnlink(paths, item.filePath, read?.stat);
    });
    if (response) processed.push(response);
    if (result?.ok === true && typeof result.afterResponse === "function") {
      try { result.afterResponse(); } catch {}
    }
  }
  return processed;
}

export async function consumeDecisionRequests({
  stateRoot,
  projectFingerprint,
  now = () => Date.now(),
  validateAndDecide,
  validateAndControl,
  validateAndOperate,
  maxRequests = 32,
  lockTtlMs = 10_000,
  __testBeforeRequestRead,
  __testAfterRequestHandled,
} = {}) {
  if (typeof validateAndDecide !== "function"
      && typeof validateAndControl !== "function"
      && typeof validateAndOperate !== "function") {
    throw new TypeError("bridge-handler-required");
  }
  const timestamp = now();
  const paths = bridgePaths(stateRoot, projectFingerprint, { create: true });
  if (requestFiles(paths, paths.requests).length === 0
      && requestFiles(paths, paths.controlRequests).length === 0
      && requestFiles(paths, paths.operationRequests).length === 0) {
    return { ok: true, processed: [], controls: [], operations: [] };
  }
  const lock = withStateMutationLock(paths.boundary, () => acquireConsumerLock(paths, timestamp, lockTtlMs));
  if (!lock) return { ok: false, reason: "bridge-lease-busy", processed: [], controls: [], operations: [] };
  try {
    const processed = await consumeType({ paths, projectFingerprint, now, maxRequests, type: "decision", handler: validateAndDecide, beforeRead: __testBeforeRequestRead, afterHandled: __testAfterRequestHandled });
    const controls = await consumeType({ paths, projectFingerprint, now, maxRequests, type: "control", handler: validateAndControl, beforeRead: __testBeforeRequestRead, afterHandled: __testAfterRequestHandled });
    const operations = await consumeOperationType({
      paths,
      projectFingerprint,
      now,
      maxRequests,
      handler: validateAndOperate,
      beforeRead: __testBeforeRequestRead,
      afterHandled: __testAfterRequestHandled,
    });
    return { ok: true, processed, controls, operations };
  } finally {
    withStateMutationLock(paths.boundary, () => releaseConsumerLock(paths, lock.nonce));
  }
}

function cleanupDirectory(paths, directory, type, projectFingerprint, now) {
  let removed = 0;
  revalidateDirectory(paths.boundary, directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const stat = lstatOptional(filePath);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      if (secureUnlink(paths, filePath, undefined, { allowSymlink: true })) removed += 1;
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) continue;
    if (!entry.name.endsWith(".json")) {
      if (entry.name.endsWith(".tmp") && now - stat.mtimeMs >= BRIDGE_TTL_MS && secureUnlink(paths, filePath, stat)) removed += 1;
      continue;
    }
    try {
      const read = secureRead(paths, filePath, type.includes("request") ? MAX_REQUEST_BYTES : MAX_RESPONSE_BYTES, type);
      const value = JSON.parse(read.source);
      const clean = type === "decision-request"
        ? makeBridgeRequest(value, { now, maxAgeMs: BRIDGE_TTL_MS, projectFingerprint })
        : type === "control-request"
          ? makeControlRequest(value, { now, maxAgeMs: BRIDGE_TTL_MS, projectFingerprint })
          : type === "operation-request"
            ? validateOperationRequestEnvelope(value, { now, projectFingerprint })
            : type === "decision-response"
              ? makeBridgeResponse(value)
              : type === "control-response"
                ? makeControlResponse(value)
                : makeUiOperationResponse(value, {
                  projectFingerprint,
                  stateRootIdentity: value?.stateRootIdentity,
                  requestId: value?.requestId,
                  action: value?.action,
                  requestHash: value?.requestHash,
                  requestIssuedAt: value?.processedAt,
                  requestExpiresAt: (value?.processedAt ?? 0) + UI_PROTOCOL_LIMITS.operationTtlMs,
                  now,
                });
      const timestamp = type === "decision-request" || type === "control-request"
        ? clean.timestamp
        : type === "operation-request"
          ? clean.issuedAt
          : clean.processedAt;
      if (timestamp > now + 30_000 || timestamp + BRIDGE_TTL_MS <= now) throw new Error("expired-or-future-envelope");
      if (entry.name !== `${clean.requestId}.json`) throw new Error("request-id-path-mismatch");
    } catch {
      const current = lstatOptional(filePath);
      if (current && current.isFile() && current.nlink === 1 && secureUnlink(paths, filePath, current)) removed += 1;
    }
  }
  return removed;
}

function cleanupUiProjectionUnlocked(paths, projectFingerprint, now) {
  const projection = uiProjectionPaths(paths);
  if (!projection) return 0;
  try {
    assertPrivateProjectionTree(paths, projection.root);
    const offerRead = secureProjectionRead(paths, projection.offer, MAX_REQUEST_BYTES, "ui-protocol-offer");
    const indexRead = secureProjectionRead(paths, projection.index, UI_PROTOCOL_LIMITS.indexBytes, "ui-projection-index");
    if (!offerRead || !indexRead) throw new Error("ui-projection-incomplete");
    const offer = makeUiProtocolOffer(JSON.parse(offerRead.source));
    const indexValue = JSON.parse(indexRead.source);
    const index = makeUiProjectionIndex(indexValue, {
      projectFingerprint,
      stateRootIdentity: computeStateRootIdentity(paths.boundary),
      generation: indexValue?.generation,
      now,
      supportedCapabilities: offer.capabilities,
    });
    const generation = uiProjectionPaths(paths, { generation: index.generation });
    if (!generation) throw new Error("ui-projection-generation-unavailable");
    let removedDashboard = 0;
    const dashboardRead = secureProjectionRead(
      paths,
      generation.dashboard,
      UI_PROTOCOL_LIMITS.dashboardBytes,
      "ui-dashboard",
    );
    if (dashboardRead) {
      try {
        makeUiDashboard(JSON.parse(dashboardRead.source), {
          projectFingerprint,
          stateRootIdentity: index.stateRootIdentity,
          generation: index.generation,
          indexHash: index.projectionHash,
          now,
        });
      } catch (error) {
        if (/owner|permissions|symlink|hardlink|replaced|path-rejected/u.test(errorReasonCode(error, "bridge-error"))) throw error;
        const current = lstatOptional(generation.dashboard);
        if (current && secureUnlink(paths, generation.dashboard, current)) removedDashboard += 1;
      }
    }
    for (const review of index.reviews) {
      const detailRead = secureProjectionRead(
        paths,
        projectionDetailPath(generation, review.proposalId),
        UI_PROTOCOL_LIMITS.detailBytes,
        "ui-review-detail",
      );
      if (!detailRead) throw new Error("ui-projection-detail-unavailable");
      const detail = makeUiReviewDetail(JSON.parse(detailRead.source), {
        projectFingerprint,
        stateRootIdentity: index.stateRootIdentity,
        generation: index.generation,
        detailRevision: review.detailRevision,
        detailHash: review.detailHash,
        now,
        supportedCapabilities: index.capabilities,
      });
      if (detail.summary.state !== review.state || detail.summary.target.relativePath !== review.target) {
        throw new Error("ui-projection-detail-index-mismatch");
      }
    }
    return removedDashboard
      + cleanupUiProjectionTempsUnlocked(paths, projection.root)
      + cleanupStaleUiGenerationsUnlocked(paths, index.generation);
  } catch (error) {
    if (/owner|permissions|symlink|hardlink|replaced|path-rejected/u.test(errorReasonCode(error, "bridge-error"))) throw error;
    return removePrivateProjectionTree(paths, projection.root);
  }
}

export function cleanupBridge(stateRoot, projectFingerprint, { now = Date.now(), lockTtlMs = 10_000 } = {}) {
  const paths = bridgePaths(stateRoot, projectFingerprint, { create: true });
  const lock = withStateMutationLock(paths.boundary, () => acquireConsumerLock(paths, now, lockTtlMs));
  if (!lock) return { ok: false, reason: "bridge-lease-busy", removed: 0 };
  let removed = 0;
  try {
    withStateMutationLock(paths.boundary, () => {
      removed += cleanupDirectory(paths, paths.requests, "decision-request", projectFingerprint, now);
      removed += cleanupDirectory(paths, paths.responses, "decision-response", projectFingerprint, now);
      removed += cleanupDirectory(paths, paths.controlRequests, "control-request", projectFingerprint, now);
      removed += cleanupDirectory(paths, paths.controlResponses, "control-response", projectFingerprint, now);
      removed += cleanupDirectory(paths, paths.operationRequests, "operation-request", projectFingerprint, now);
      removed += cleanupDirectory(paths, paths.operationResponses, "operation-response", projectFingerprint, now);
      try {
        const read = secureRead(paths, paths.controlState, MAX_CONTROL_STATE_BYTES, "control-state");
        if (read) makeControlState(JSON.parse(read.source), { now, projectFingerprint });
      } catch {
        const state = lstatOptional(paths.controlState);
        if (state?.isFile() && state.nlink === 1 && secureUnlink(paths, paths.controlState, state)) removed += 1;
      }
      try {
        const read = secureReadTuiHostHealth(paths);
        if (read) {
          const health = makeTuiHostHealth(JSON.parse(read.source), {
            now,
            projectFingerprint,
            stateRootIdentity: computeStateRootIdentity(paths.boundary),
          });
          if (!sameAccountProcessIsAlive(health.publisherPid)) throw new Error("stale-tui-host-health-publisher");
        }
      } catch {
        const health = lstatOptional(paths.tuiHostHealth);
        if (health?.isFile() && health.nlink === 1 && secureUnlink(paths, paths.tuiHostHealth, health)) removed += 1;
      }
      removed += cleanupUiProjectionUnlocked(paths, projectFingerprint, now);
    });
    return { ok: true, removed };
  } finally {
    withStateMutationLock(paths.boundary, () => releaseConsumerLock(paths, lock.nonce));
  }
}
