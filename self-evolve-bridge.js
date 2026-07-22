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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  DEFAULT_BUDGETS,
  SCHEMA_VERSION,
  assertRecord,
  makeDecision,
  makeGlobalSettings,
  makeProposal,
  makeRepoSettings,
} from "./self-evolve-schemas.js";
import { withStateMutationLock } from "./self-evolve-lock.js";

export const BRIDGE_TTL_MS = 24 * 60 * 60 * 1000;
export const BRIDGE_ACTOR = "self-evolve-tui";
export const BRIDGE_SERVER_ACTOR = "self-evolve-integration";
export const BRIDGE_REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "requestId", "projectFingerprint", "proposalId", "targetHash",
  "proposedContentHash", "decisionVersion", "priorState", "newState", "actor",
  "timestamp", "nonce",
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
export const CONTROL_ACTIONS = Object.freeze(["set-mode", "set-consent", "set-repo-excluded", "update-allowlist"]);

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
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
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

function reason(error) {
  return String(error?.message ?? error ?? "bridge-error").split(":", 1)[0];
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
  if (![requests, responses, controlRequests, controlResponses].every(Boolean)) return null;
  return {
    boundary, fingerprint, root, requests, responses, controlRequests, controlResponses,
    lock: path.join(root, "consumer.lock"),
    controlState: path.join(root, "control-state.json"),
  };
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
  const requestRoots = new Set([paths.requests, paths.controlRequests]);
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
  const removingPending = removed && (path.dirname(removePath) === paths.requests || path.dirname(removePath) === paths.controlRequests) ? 1 : 0;
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

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export function makeBridgeRequest(value, { now = Date.now(), maxAgeMs = BRIDGE_TTL_MS, projectFingerprint } = {}) {
  exactKeys(value, BRIDGE_REQUEST_FIELDS, "bridge-request");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("unsupported-schema-version");
  const request = Object.freeze({
    schemaVersion: value.schemaVersion,
    requestId: validId(value.requestId, "request-id"),
    projectFingerprint: validHash(value.projectFingerprint, "project-fingerprint"),
    proposalId: validId(value.proposalId, "proposal-id"),
    targetHash: validHash(value.targetHash, "target-hash"),
    proposedContentHash: validHash(value.proposedContentHash, "proposed-content-hash"),
    decisionVersion: value.decisionVersion,
    priorState: value.priorState,
    newState: value.newState,
    actor: value.actor,
    timestamp: validTimestamp(value.timestamp),
    nonce: validId(value.nonce, "nonce"),
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
  } else {
    throw new TypeError("unknown-bridge-export-class");
  }
  if (clean.projectFingerprint !== projectFingerprint) throw new TypeError("cross-project-bridge-export");
  if (requestId !== undefined && clean.requestId !== requestId) throw new TypeError("request-id-path-mismatch");
  return clean;
}

export function createDecisionRequest({ projectFingerprint, proposal, newState, actor = BRIDGE_ACTOR, timestamp = Date.now(), requestId = randomBytes(16).toString("hex") } = {}) {
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

function pollResponse(stateRoot, projectFingerprint, requestId, type) {
  const paths = bridgePaths(stateRoot, projectFingerprint);
  if (!paths) return null;
  const id = validId(requestId, "request-id");
  const directory = type === "control" ? paths.controlResponses : paths.responses;
  const filePath = path.join(directory, `${id}.json`);
  let read;
  try { read = secureRead(paths, filePath, MAX_RESPONSE_BYTES, `${type}-response`); }
  catch (error) { if (/hardlink-rejected$/u.test(reason(error))) return null; throw error; }
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

function acquireConsumerLock(paths, now, ttlMs) {
  const lease = { pid: process.pid, acquiredAt: now, expiresAt: now + ttlMs, nonce: randomBytes(16).toString("hex") };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      atomicWrite(paths, paths.lock, boundedJson(lease, 1024, "bridge-lock"), { exclusive: true });
      return lease;
    } catch (error) {
      if (error?.code !== "EEXIST" && reason(error) !== "bridge-file-exists") return null;
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

async function consumeType({ paths, projectFingerprint, now, maxRequests, type, handler, beforeRead }) {
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
      result = { ok: false, reason: reason(error) };
    }
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

export async function consumeDecisionRequests({ stateRoot, projectFingerprint, now = () => Date.now(), validateAndDecide, validateAndControl, maxRequests = 32, lockTtlMs = 10_000, __testBeforeRequestRead } = {}) {
  if (typeof validateAndDecide !== "function" && typeof validateAndControl !== "function") throw new TypeError("bridge-handler-required");
  const timestamp = now();
  const paths = bridgePaths(stateRoot, projectFingerprint, { create: true });
  if (requestFiles(paths, paths.requests).length === 0 && requestFiles(paths, paths.controlRequests).length === 0) {
    return { ok: true, processed: [], controls: [] };
  }
  const lock = withStateMutationLock(paths.boundary, () => acquireConsumerLock(paths, timestamp, lockTtlMs));
  if (!lock) return { ok: false, reason: "bridge-lease-busy", processed: [], controls: [] };
  try {
    const processed = await consumeType({ paths, projectFingerprint, now, maxRequests, type: "decision", handler: validateAndDecide, beforeRead: __testBeforeRequestRead });
    const controls = await consumeType({ paths, projectFingerprint, now, maxRequests, type: "control", handler: validateAndControl, beforeRead: __testBeforeRequestRead });
    return { ok: true, processed, controls };
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
          : type === "decision-response" ? makeBridgeResponse(value) : makeControlResponse(value);
      const timestamp = type.endsWith("request") ? clean.timestamp : clean.processedAt;
      if (timestamp > now + 30_000 || timestamp + BRIDGE_TTL_MS <= now) throw new Error("expired-or-future-envelope");
      if (entry.name !== `${clean.requestId}.json`) throw new Error("request-id-path-mismatch");
    } catch {
      const current = lstatOptional(filePath);
      if (current && current.isFile() && current.nlink === 1 && secureUnlink(paths, filePath, current)) removed += 1;
    }
  }
  return removed;
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
      try {
        const read = secureRead(paths, paths.controlState, MAX_CONTROL_STATE_BYTES, "control-state");
        if (read) makeControlState(JSON.parse(read.source), { now, projectFingerprint });
      } catch {
        const state = lstatOptional(paths.controlState);
        if (state?.isFile() && state.nlink === 1 && secureUnlink(paths, paths.controlState, state)) removed += 1;
      }
    });
    return { ok: true, removed };
  } finally {
    withStateMutationLock(paths.boundary, () => releaseConsumerLock(paths, lock.nonce));
  }
}
