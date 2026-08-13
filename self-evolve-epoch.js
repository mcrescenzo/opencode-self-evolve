// Root-global epoch primitive: the single cross-process authority truth for the
// self-evolve state root. The epoch file lives OUTSIDE the deletable
// `<stateRoot>/self-evolve/` subtree (so it survives purge-all) but INSIDE the
// validated state-root boundary (durable-state confinement). Every process
// sharing the state root reads it at boot, at every mutation-lock acquisition,
// and at every admission/authority boundary. A terminal epoch fails every
// authoritative boundary closed with a stable reason. Authority returns ONLY
// through an authenticated explicit reinitialize operation that creates a NEW
// root epoch generation.
//
// The on-disk record carries only partition-safe hashes (root identity hash,
// nonce hashes, schema/protocol version bindings); it never stores private
// project identity, worktree paths, source identity, or consent detail beyond a
// hash. It is appended to the same validated state root that the lock file
// (`.self-evolve-mutation.lock`) already occupies as a direct root child.
//
// Generation rule:
//   - Absent file  = implicit generation 1, live (backward compatible).
//   - markTerminal = writes the current generation with terminal=true
//                    (idempotent within a generation; the first terminal write
//                    on an absent root establishes generation 1).
//   - reinitialize = increments the generation and clears terminal. Requires the
//     current epoch to be terminal and a full authenticated commitment.
//
// Permanent capability boundary: this module uses only local filesystem and
// hashing primitives via the shared power-loss-durable namespace primitive
// (`self-evolve-durable.js`). It must never gain subprocess, source-control,
// remote I/O, package-manager, model/agent, dynamic-loader, or publication
// capabilities, and (dual-target invariant) it must not import the TUI target.

import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  createDurableFilesystem,
  syncDirectoryFsync,
  DIRECTORY_FSYNC_UNAVAILABLE,
} from "./self-evolve-durable.js";

export const ROOT_EPOCH_FILENAME = ".self-evolve-root-epoch.json";
export const ROOT_EPOCH_SCHEMA_VERSION = "self-evolve-root-epoch-v1";
export const ROOT_EPOCH_TERMINAL_REASON = "root-epoch-terminal";
export const ROOT_EPOCH_REINITIALIZE_CONFIRMATION = "REINITIALIZE SELF-EVOLVE 0.4.0";

// Root-global circuit-breaker epoch: a sibling durable authority truth for the
// autonomous-work circuit breaker. It lives alongside the terminal/reinitialize
// root epoch (same state-root boundary, same durable namespace primitive, same
// cross-process admission semantics) but tracks a SEPARATE concern: whether the
// circuit breaker is currently tripped (open) across every process sharing the
// state root. It is NOT a parallel authority model — it composes with the root
// epoch by reusing this module's validation, freeze, source-byte cache, and
// durable-replace primitives. The terminal/reinitialize epoch owns purge
// terminality; the breaker epoch owns cross-process breaker open/closed truth.
export const BREAKER_EPOCH_FILENAME = ".self-evolve-breaker-epoch.json";
export const BREAKER_EPOCH_SCHEMA_VERSION = "self-evolve-breaker-epoch-v1";
export const BREAKER_EPOCH_TRIPPED_REASON = "breaker-epoch-tripped";
export const BREAKER_EPOCH_RESET_CONFIRMATION = "RESET SELF-EVOLVE BREAKER 0.3.0";

// Reversible ordinary automation authority. This epoch is deliberately
// separate from terminal-root and circuit-breaker truth: turning Automatic
// recommendations Off must fence peers without purging the state subtree or
// impersonating a breaker trip. The store serializes writes with the shared
// state mutation lock; this module owns only the exact durable record and
// generation comparison primitive.
export const AUTOMATION_EPOCH_FILENAME = ".self-evolve-automation-epoch.json";
export const AUTOMATION_EPOCH_SCHEMA_VERSION = "self-evolve-automation-epoch-v1";
export const AUTOMATION_EPOCH_INVALID_REASON = "automation-epoch-invalid";

const ROOT_EPOCH_MAX_BYTES = 4 * 1024;
const BREAKER_EPOCH_MAX_BYTES = 4 * 1024;
const AUTOMATION_EPOCH_MAX_BYTES = 4 * 1024;
const COMMITMENT_FIELDS = Object.freeze([
  "rootIdentityHash",
  "projectFingerprintHash",
  "schemaVersion",
  "protocolVersion",
  "nonceHash",
  "consentSnapshotHash",
  "operatorAuthority",
  "committedAt",
]);
const EPOCH_FIELDS = Object.freeze([
  "schemaVersion",
  "generation",
  "terminal",
  "terminalAt",
  "terminalOperationId",
  "rootIdentityHash",
  "reinitializeCommitment",
  "updatedAt",
]);
const HEX64 = /^[a-f0-9]{64}$/u;

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function isHex64(value) {
  return typeof value === "string" && HEX64.test(value);
}

function asTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`root-epoch-corrupt:${label}`);
  return value;
}

function asOptionalHex64(value, label) {
  if (value === null) return null;
  if (!isHex64(value)) throw new Error(`root-epoch-corrupt:${label}`);
  return value;
}

function asOptionalString(value, label, maxLen) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    throw new Error(`root-epoch-corrupt:${label}`);
  }
  return value;
}

function validateCommitment(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("root-epoch-corrupt:commitment");
  const keys = Object.keys(raw);
  if (keys.length !== COMMITMENT_FIELDS.length) throw new Error("root-epoch-corrupt:commitment-fields");
  for (const field of COMMITMENT_FIELDS) {
    if (!Object.hasOwn(raw, field)) throw new Error("root-epoch-corrupt:commitment-fields");
  }
  const commitment = {
    rootIdentityHash: asOptionalHex64(raw.rootIdentityHash, "commitment-root-identity"),
    projectFingerprintHash: asOptionalHex64(raw.projectFingerprintHash, "commitment-project-fingerprint"),
    schemaVersion: asOptionalString(raw.schemaVersion, "commitment-schema-version", 64),
    protocolVersion: asOptionalString(raw.protocolVersion, "commitment-protocol-version", 64),
    nonceHash: asOptionalHex64(raw.nonceHash, "commitment-nonce"),
    consentSnapshotHash: asOptionalHex64(raw.consentSnapshotHash, "commitment-consent"),
    operatorAuthority: asOptionalString(raw.operatorAuthority, "commitment-operator", 64),
    committedAt: raw.committedAt === null ? null : asTimestamp(raw.committedAt, "commitment-committed-at"),
  };
  return deepFreeze(commitment);
}

// Validate and freeze a parsed epoch record from raw JSON. Throws a stable
// `root-epoch-corrupt` reason for any shape, type, key, or hash violation so a
// tampered or partially-written epoch fails closed everywhere it is read.
export function parseEpochRecord(source) {
  if (typeof source !== "string" || source.length === 0) throw new Error("root-epoch-corrupt:empty");
  let raw;
  try { raw = JSON.parse(source); } catch { throw new Error("root-epoch-corrupt:json"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("root-epoch-corrupt:shape");
  const keys = Object.keys(raw);
  if (keys.length !== EPOCH_FIELDS.length) throw new Error("root-epoch-corrupt:fields");
  for (const field of EPOCH_FIELDS) {
    if (!Object.hasOwn(raw, field)) throw new Error("root-epoch-corrupt:fields");
  }
  if (raw.schemaVersion !== ROOT_EPOCH_SCHEMA_VERSION) throw new Error("root-epoch-unsupported-version");
  if (!Number.isSafeInteger(raw.generation) || raw.generation < 1) throw new Error("root-epoch-corrupt:generation");
  if (typeof raw.terminal !== "boolean") throw new Error("root-epoch-corrupt:terminal");
  const terminalAt = raw.terminalAt === null ? null : asTimestamp(raw.terminalAt, "terminal-at");
  if ((raw.terminal === true) !== (terminalAt !== null)) throw new Error("root-epoch-corrupt:terminal-at");
  const terminalOperationId = asOptionalString(raw.terminalOperationId, "terminal-operation-id", 128);
  if ((terminalOperationId !== null) !== (raw.terminal === true)) throw new Error("root-epoch-corrupt:terminal-operation");
  const rootIdentityHash = asOptionalHex64(raw.rootIdentityHash, "root-identity");
  const reinitializeCommitment = validateCommitment(raw.reinitializeCommitment);
  if ((reinitializeCommitment !== null) === (raw.terminal === true)) {
    throw new Error("root-epoch-corrupt:commitment-terminal");
  }
  const updatedAt = asTimestamp(raw.updatedAt, "updated-at");
  if (terminalAt !== null && updatedAt < terminalAt) throw new Error("root-epoch-corrupt:updated-before-terminal");
  return deepFreeze({
    schemaVersion: raw.schemaVersion,
    generation: raw.generation,
    terminal: raw.terminal,
    terminalAt,
    terminalOperationId,
    rootIdentityHash,
    reinitializeCommitment,
    updatedAt,
  });
}

// The implicit live epoch used when no epoch file exists (backward compatible
// with state roots created before the epoch primitive). Generation 1 so the
// first terminal write and first reinitialize produce a monotonically
// increasing counter without a special case.
export const IMPLICIT_LIVE_EPOCH = deepFreeze({
  schemaVersion: ROOT_EPOCH_SCHEMA_VERSION,
  generation: 1,
  terminal: false,
  terminalAt: null,
  terminalOperationId: null,
  rootIdentityHash: null,
  reinitializeCommitment: null,
  updatedAt: 0,
});

export function epochFilePath(stateRoot) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("state-root-required");
  return path.join(stateRoot, ROOT_EPOCH_FILENAME);
}

function readRawBytes(filePath, maxBytes, label) {
  if (!existsSync(filePath)) return null;
  const source = readFileSync(filePath, "utf8");
  if (Buffer.byteLength(source, "utf8") > maxBytes) throw new Error(`${label}:oversized`);
  return source;
}

function readRawEpochBytes(filePath) {
  return readRawBytes(filePath, ROOT_EPOCH_MAX_BYTES, "root-epoch-corrupt");
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function newNonce() {
  return randomBytes(24).toString("hex");
}

// Create a bound root-epoch manager over one state root and one set of injectable
// durable-filesystem dependencies. `durable` is a `createDurableFilesystem`
// instance probed against the state root; if omitted a fresh one is created. All
// authoritative writes (markTerminal, reinitialize) use the power-loss-durable
// replace/create primitives so a peer (or a restarted process) observes a
// completed terminal/reinitialize epoch after recovery.
export function createRootEpochManager({
  stateRoot,
  durable = null,
  syncFile = null,
  syncDirectory = null,
  now = () => Date.now(),
} = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("state-root-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  const filePath = epochFilePath(stateRoot);
  const bound = durable ?? createDurableFilesystem({
    syncFile: syncFile ?? undefined,
    syncDirectory: syncDirectory ?? syncDirectoryFsync,
    probeDirectory: stateRoot,
  });
  // Source-byte cache: a peer's terminal/reinitialize write changes the bytes,
  // so the cache invalidates automatically. Keeps repeated admission-cycle reads
  // cheap while remaining cross-process correct.
  let cachedSource = undefined;
  let cachedEpoch = null;

  function read() {
    let source;
    try { source = readRawEpochBytes(filePath); } catch (error) {
      cachedSource = undefined;
      cachedEpoch = null;
      throw error;
    }
    if (source === null) {
      cachedSource = null;
      cachedEpoch = IMPLICIT_LIVE_EPOCH;
      return IMPLICIT_LIVE_EPOCH;
    }
    if (source === cachedSource && cachedEpoch) return cachedEpoch;
    const epoch = parseEpochRecord(source);
    cachedSource = source;
    cachedEpoch = epoch;
    return epoch;
  }

  function readTerminalReason() {
    const epoch = read();
    return epoch.terminal ? ROOT_EPOCH_TERMINAL_REASON : null;
  }

  function isTerminal() {
    try { return read().terminal; } catch { return true; }
  }

  function assertAuthoritativeCapability() {
    if (!bound.capability.available) {
      throw new Error(bound.capability.reason ?? DIRECTORY_FSYNC_UNAVAILABLE);
    }
  }

  function serialize(record) {
    return `${JSON.stringify(record)}\n`;
  }

  function writeTerminalEpoch({ terminalOperationId = null, rootIdentityHash = null } = {}) {
    assertAuthoritativeCapability();
    const current = read();
    if (current.terminal) return current;
    const timestamp = now();
    const generation = current.generation;
    const record = deepFreeze({
      schemaVersion: ROOT_EPOCH_SCHEMA_VERSION,
      generation,
      terminal: true,
      terminalAt: timestamp,
      terminalOperationId: asOptionalString(terminalOperationId, "terminal-operation-id", 128) ?? `terminal-${generation}`,
      rootIdentityHash: rootIdentityHash ?? current.rootIdentityHash,
      reinitializeCommitment: null,
      updatedAt: timestamp,
    });
    const source = serialize(record);
    if (!existsSync(filePath)) bound.durableCreateExclusive(filePath, source);
    else bound.durableReplaceFile(filePath, source);
    cachedSource = source;
    cachedEpoch = record;
    return record;
  }

  function buildCommitment(authentication) {
    if (!authentication || typeof authentication !== "object") {
      throw new TypeError("reinitialize-authentication-required");
    }
    const rootIdentityHash = asOptionalHex64(authentication.rootIdentityHash ?? null, "auth-root-identity");
    const projectFingerprintHash = asOptionalHex64(authentication.projectFingerprintHash ?? null, "auth-project-fingerprint");
    const schemaVersion = asOptionalString(authentication.schemaVersion ?? null, "auth-schema-version", 64);
    const protocolVersion = asOptionalString(authentication.protocolVersion ?? null, "auth-protocol-version", 64);
    const nonce = typeof authentication.nonce === "string" && authentication.nonce.length >= 16 && authentication.nonce.length <= 128
      ? authentication.nonce
      : newNonce();
    const consentSnapshotHash = asOptionalHex64(authentication.consentSnapshotHash ?? null, "auth-consent");
    const operatorAuthority = asOptionalString(authentication.operatorAuthority ?? null, "auth-operator", 64) ?? "operator";
    const committedAt = now();
    return {
      rootIdentityHash,
      projectFingerprintHash,
      schemaVersion,
      protocolVersion,
      nonceHash: hashJson(["root-epoch-reinitialize-nonce-v1", nonce]),
      consentSnapshotHash,
      operatorAuthority,
      committedAt,
    };
  }

  // Authenticated explicit reinitialize. Requires the current epoch to be
  // terminal (you can only reinitialize a purged root), a full authenticated
  // commitment (fresh root/project identity, schema/protocol versions, one-use
  // nonce, consent snapshot, operator authority), and an exact operator-typed
  // confirmation. Increments the generation and clears terminal. Replay-safe:
  // once reinitialize succeeds the epoch is non-terminal, so a replayed attempt
  // (or any attempt on a live root) fails with a stable reason. Cannot be
  // model-selected: the exact confirmation and operator authority are only
  // reachable through an operator-typed command or a freshly validated native
  // operation grant.
  function reinitialize({ confirmation, authentication, rootIdentityHash = null } = {}) {
    assertAuthoritativeCapability();
    if (confirmation !== ROOT_EPOCH_REINITIALIZE_CONFIRMATION) {
      throw new Error("reinitialize-confirmation-mismatch");
    }
    const current = read();
    if (!current.terminal) throw new Error("root-epoch-not-terminal");
    const commitment = buildCommitment(authentication);
    const timestamp = now();
    const generation = current.generation + 1;
    const record = deepFreeze({
      schemaVersion: ROOT_EPOCH_SCHEMA_VERSION,
      generation,
      terminal: false,
      terminalAt: null,
      terminalOperationId: null,
      rootIdentityHash: rootIdentityHash ?? current.rootIdentityHash,
      reinitializeCommitment: commitment,
      updatedAt: timestamp,
    });
    const source = serialize(record);
    bound.durableReplaceFile(filePath, source);
    cachedSource = source;
    cachedEpoch = record;
    return record;
  }

  function invalidate() {
    cachedSource = undefined;
    cachedEpoch = null;
  }

  return Object.freeze({
    filePath,
    read,
    readTerminalReason,
    isTerminal,
    writeTerminalEpoch,
    reinitialize,
    invalidate,
    capability: bound.capability,
  });
}

// ============================================================
// Root-global Automatic recommendations epoch
// ============================================================

const AUTOMATION_EPOCH_FIELDS = Object.freeze([
  "schemaVersion",
  "generation",
  "enabled",
  "permissionsHash",
  "lastTransitionId",
  "lastTransitionHash",
  "rootIdentityHash",
  "updatedAt",
]);
const AUTOMATION_TRANSITION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const DEFAULT_AUTOMATION_PERMISSIONS_HASH = createHash("sha256").update(
  "self-evolve-automation-permissions-v1\n"
  + JSON.stringify({ crossRepoAggregation: true, durableObservations: true, sanitizedExcerpts: true }),
).digest("hex");

function automationError(label) {
  return new Error(`automation-epoch-corrupt:${label}`);
}

function automationTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw automationError(label);
  return value;
}

function automationTransitionId(value, label = "transition-id") {
  if (value === null) return null;
  if (typeof value !== "string" || !AUTOMATION_TRANSITION_ID.test(value)) throw automationError(label);
  return value;
}

function automationOptionalHex64(value, label) {
  if (value === null) return null;
  if (!isHex64(value)) throw automationError(label);
  return value;
}

export function parseAutomationEpochRecord(source) {
  if (typeof source !== "string" || source.length === 0) throw automationError("empty");
  let raw;
  try { raw = JSON.parse(source); } catch { throw automationError("json"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw automationError("shape");
  if (Object.keys(raw).sort().join(",") !== [...AUTOMATION_EPOCH_FIELDS].sort().join(",")) {
    throw automationError("fields");
  }
  if (raw.schemaVersion !== AUTOMATION_EPOCH_SCHEMA_VERSION) throw new Error("automation-epoch-unsupported-version");
  if (!Number.isSafeInteger(raw.generation) || raw.generation < 1) throw automationError("generation");
  if (typeof raw.enabled !== "boolean") throw automationError("enabled");
  if (!isHex64(raw.permissionsHash)) throw automationError("permissions-hash");
  const lastTransitionId = automationTransitionId(raw.lastTransitionId);
  const lastTransitionHash = automationOptionalHex64(raw.lastTransitionHash, "transition-hash");
  if ((lastTransitionId === null) !== (lastTransitionHash === null)) throw automationError("transition-binding");
  const rootIdentityHash = automationOptionalHex64(raw.rootIdentityHash, "root-identity");
  const updatedAt = automationTimestamp(raw.updatedAt, "updated-at");
  return deepFreeze({
    schemaVersion: raw.schemaVersion,
    generation: raw.generation,
    enabled: raw.enabled,
    permissionsHash: raw.permissionsHash,
    lastTransitionId,
    lastTransitionHash,
    rootIdentityHash,
    updatedAt,
  });
}

export const IMPLICIT_AUTOMATION_EPOCH = deepFreeze({
  schemaVersion: AUTOMATION_EPOCH_SCHEMA_VERSION,
  generation: 1,
  enabled: true,
  permissionsHash: DEFAULT_AUTOMATION_PERMISSIONS_HASH,
  lastTransitionId: null,
  lastTransitionHash: null,
  rootIdentityHash: null,
  updatedAt: 0,
});

export function automationEpochFilePath(stateRoot) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("state-root-required");
  return path.join(stateRoot, AUTOMATION_EPOCH_FILENAME);
}

export function createAutomationEpochManager({
  stateRoot,
  durable = null,
  syncFile = null,
  syncDirectory = null,
  now = () => Date.now(),
} = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("state-root-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  const filePath = automationEpochFilePath(stateRoot);
  const bound = durable ?? createDurableFilesystem({
    syncFile: syncFile ?? undefined,
    syncDirectory: syncDirectory ?? syncDirectoryFsync,
    probeDirectory: stateRoot,
  });
  let cachedSource = undefined;
  let cachedEpoch = null;

  function read() {
    let source;
    try { source = readRawBytes(filePath, AUTOMATION_EPOCH_MAX_BYTES, "automation-epoch-corrupt"); } catch (error) {
      cachedSource = undefined;
      cachedEpoch = null;
      throw error;
    }
    if (source === null) {
      cachedSource = null;
      cachedEpoch = IMPLICIT_AUTOMATION_EPOCH;
      return IMPLICIT_AUTOMATION_EPOCH;
    }
    if (source === cachedSource && cachedEpoch) return cachedEpoch;
    const epoch = parseAutomationEpochRecord(source);
    cachedSource = source;
    cachedEpoch = epoch;
    return epoch;
  }

  function readAuthority() {
    try {
      const record = read();
      return deepFreeze({ ok: true, enabled: record.enabled, generation: record.generation, permissionsHash: record.permissionsHash });
    } catch (error) {
      return deepFreeze({ ok: false, enabled: false, generation: null, permissionsHash: null, reason: AUTOMATION_EPOCH_INVALID_REASON });
    }
  }

  function stamp() {
    const record = read();
    const body = {
      generation: record.generation,
      enabled: record.enabled,
      permissionsHash: record.permissionsHash,
      rootIdentityHash: record.rootIdentityHash,
    };
    return deepFreeze({ ...body, epochHash: hashJson(["self-evolve-automation-stamp-v1", body]) });
  }

  function compare(candidate) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    try {
      const current = stamp();
      return Object.keys(current).every((key) => candidate[key] === current[key])
        && Object.keys(candidate).length === Object.keys(current).length;
    } catch {
      return false;
    }
  }

  function transition({
    transitionId,
    transitionHash,
    expectedGeneration,
    enabled,
    permissionsHash,
    rootIdentityHash = null,
  } = {}) {
    if (!bound.capability.available) throw new Error(bound.capability.reason ?? DIRECTORY_FSYNC_UNAVAILABLE);
    const cleanId = automationTransitionId(transitionId);
    if (cleanId === null) throw new TypeError("automation-transition-id-required");
    if (!isHex64(transitionHash)) throw new TypeError("automation-transition-hash-required");
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new TypeError("automation-generation-required");
    if (typeof enabled !== "boolean") throw new TypeError("automation-enabled-required");
    if (!isHex64(permissionsHash)) throw new TypeError("automation-permissions-hash-required");
    if (rootIdentityHash !== null && !isHex64(rootIdentityHash)) throw new TypeError("automation-root-identity-invalid");
    const current = read();
    if (current.lastTransitionId === cleanId) {
      if (current.lastTransitionHash !== transitionHash
        || current.enabled !== enabled
        || current.permissionsHash !== permissionsHash) {
        throw new Error("automation-transition-conflict");
      }
      return deepFreeze({ record: current, duplicate: true });
    }
    if (current.generation !== expectedGeneration) throw new Error("stale-automation-generation");
    const record = deepFreeze({
      schemaVersion: AUTOMATION_EPOCH_SCHEMA_VERSION,
      generation: current.generation + 1,
      enabled,
      permissionsHash,
      lastTransitionId: cleanId,
      lastTransitionHash: transitionHash,
      rootIdentityHash: rootIdentityHash ?? current.rootIdentityHash,
      updatedAt: now(),
    });
    const source = `${JSON.stringify(record)}\n`;
    if (!existsSync(filePath)) bound.durableCreateExclusive(filePath, source);
    else bound.durableReplaceFile(filePath, source);
    cachedSource = source;
    cachedEpoch = record;
    return deepFreeze({ record, duplicate: false });
  }

  // Re-establish the On baseline only after the terminal-root manager has
  // accepted an authenticated reinitialize and produced a new nonterminal root
  // epoch commitment. This is the sole path allowed to replace a corrupt
  // automation epoch; ordinary On/Off transitions always require a fresh valid
  // generation. The root commitment and deterministic transition identity make
  // a crash retry idempotent.
  function reinitializeBaseline({ rootEpochRecord, transitionId, transitionHash, rootIdentityHash = null } = {}) {
    if (!bound.capability.available) throw new Error(bound.capability.reason ?? DIRECTORY_FSYNC_UNAVAILABLE);
    const authenticatedRoot = parseEpochRecord(JSON.stringify(rootEpochRecord));
    if (authenticatedRoot.terminal || authenticatedRoot.reinitializeCommitment === null) {
      throw new Error("automation-reinitialize-authentication-required");
    }
    const cleanId = automationTransitionId(transitionId);
    if (cleanId === null || !isHex64(transitionHash)) throw new Error("automation-reinitialize-binding-invalid");
    if (rootIdentityHash !== null && !isHex64(rootIdentityHash)) throw new Error("automation-root-identity-invalid");
    let current = null;
    try { current = read(); } catch { /* authenticated terminal recovery may replace corrupt automation truth */ }
    if (current?.lastTransitionId === cleanId) {
      if (current.lastTransitionHash !== transitionHash
        || !current.enabled
        || current.permissionsHash !== DEFAULT_AUTOMATION_PERMISSIONS_HASH) {
        throw new Error("automation-transition-conflict");
      }
      return deepFreeze({ record: current, duplicate: true });
    }
    const record = deepFreeze({
      schemaVersion: AUTOMATION_EPOCH_SCHEMA_VERSION,
      generation: Math.max(current?.generation ?? 0, authenticatedRoot.generation) + 1,
      enabled: true,
      permissionsHash: DEFAULT_AUTOMATION_PERMISSIONS_HASH,
      lastTransitionId: cleanId,
      lastTransitionHash: transitionHash,
      rootIdentityHash: rootIdentityHash ?? current?.rootIdentityHash ?? authenticatedRoot.rootIdentityHash,
      updatedAt: now(),
    });
    const source = `${JSON.stringify(record)}\n`;
    if (!existsSync(filePath)) bound.durableCreateExclusive(filePath, source);
    else bound.durableReplaceFile(filePath, source);
    cachedSource = source;
    cachedEpoch = record;
    return deepFreeze({ record, duplicate: false });
  }

  function invalidate() {
    cachedSource = undefined;
    cachedEpoch = null;
  }

  return Object.freeze({
    filePath,
    read,
    readAuthority,
    stamp,
    compare,
    transition,
    reinitializeBaseline,
    invalidate,
    capability: bound.capability,
  });
}

// ============================================================
// Root-global circuit-breaker epoch
// ============================================================
//
// Same durable/validation/cache pattern as the terminal/reinitialize root
// epoch, persisted as a sibling file at `<stateRoot>/.self-evolve-breaker-epoch.json`
// (outside the deletable subtree, inside the validated state-root boundary).
// Records carry only partition-safe hashes and bounded metadata; they never
// store private project identity or consent detail beyond a hash.

const BREAKER_EPOCH_RESET_COMMITMENT_FIELDS = Object.freeze([
  "rootIdentityHash",
  "projectFingerprintHash",
  "schemaVersion",
  "protocolVersion",
  "nonceHash",
  "operatorAuthority",
  "committedAt",
]);
const BREAKER_EPOCH_FIELDS = Object.freeze([
  "schemaVersion",
  "generation",
  "tripped",
  "trippedAt",
  "trippedReason",
  "tripOperationId",
  "rootIdentityHash",
  "resetCommitment",
  "updatedAt",
]);
const BREAKER_REASON_MAX_LEN = 256;
const BREAKER_OPERATION_ID_MAX_LEN = 128;

function validateResetCommitment(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("breaker-epoch-corrupt:commitment");
  const keys = Object.keys(raw);
  if (keys.length !== BREAKER_EPOCH_RESET_COMMITMENT_FIELDS.length) throw new Error("breaker-epoch-corrupt:commitment-fields");
  for (const field of BREAKER_EPOCH_RESET_COMMITMENT_FIELDS) {
    if (!Object.hasOwn(raw, field)) throw new Error("breaker-epoch-corrupt:commitment-fields");
  }
  const commitment = {
    rootIdentityHash: asOptionalHex64(raw.rootIdentityHash, "breaker-commitment-root-identity"),
    projectFingerprintHash: asOptionalHex64(raw.projectFingerprintHash, "breaker-commitment-project-fingerprint"),
    schemaVersion: asOptionalString(raw.schemaVersion, "breaker-commitment-schema-version", 64),
    protocolVersion: asOptionalString(raw.protocolVersion, "breaker-commitment-protocol-version", 64),
    nonceHash: asOptionalHex64(raw.nonceHash, "breaker-commitment-nonce"),
    operatorAuthority: asOptionalString(raw.operatorAuthority, "breaker-commitment-operator", 64),
    committedAt: raw.committedAt === null ? null : asTimestamp(raw.committedAt, "breaker-commitment-committed-at"),
  };
  return deepFreeze(commitment);
}

function asOptionalReason(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > BREAKER_REASON_MAX_LEN) {
    throw new Error(`breaker-epoch-corrupt:${label}`);
  }
  return value;
}

// Validate and freeze a parsed breaker epoch record. Throws a stable
// `breaker-epoch-corrupt` reason for any shape, type, key, or hash violation so
// a tampered or partially-written breaker epoch fails closed (treated as
// tripped) everywhere it is read.
export function parseBreakerEpochRecord(source) {
  if (typeof source !== "string" || source.length === 0) throw new Error("breaker-epoch-corrupt:empty");
  let raw;
  try { raw = JSON.parse(source); } catch { throw new Error("breaker-epoch-corrupt:json"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("breaker-epoch-corrupt:shape");
  const keys = Object.keys(raw);
  if (keys.length !== BREAKER_EPOCH_FIELDS.length) throw new Error("breaker-epoch-corrupt:fields");
  for (const field of BREAKER_EPOCH_FIELDS) {
    if (!Object.hasOwn(raw, field)) throw new Error("breaker-epoch-corrupt:fields");
  }
  if (raw.schemaVersion !== BREAKER_EPOCH_SCHEMA_VERSION) throw new Error("breaker-epoch-unsupported-version");
  if (!Number.isSafeInteger(raw.generation) || raw.generation < 1) throw new Error("breaker-epoch-corrupt:generation");
  if (typeof raw.tripped !== "boolean") throw new Error("breaker-epoch-corrupt:tripped");
  const trippedAt = raw.trippedAt === null ? null : asTimestamp(raw.trippedAt, "tripped-at");
  if ((raw.tripped === true) !== (trippedAt !== null)) throw new Error("breaker-epoch-corrupt:tripped-at");
  const trippedReason = asOptionalReason(raw.trippedReason, "tripped-reason");
  if ((trippedReason !== null) !== (raw.tripped === true)) throw new Error("breaker-epoch-corrupt:tripped-reason");
  const tripOperationId = asOptionalString(raw.tripOperationId, "trip-operation-id", BREAKER_OPERATION_ID_MAX_LEN);
  if ((tripOperationId !== null) !== (raw.tripped === true)) throw new Error("breaker-epoch-corrupt:trip-operation");
  const rootIdentityHash = asOptionalHex64(raw.rootIdentityHash, "breaker-root-identity");
  const resetCommitment = validateResetCommitment(raw.resetCommitment);
  if ((resetCommitment !== null) === (raw.tripped === true)) {
    throw new Error("breaker-epoch-corrupt:commitment-tripped");
  }
  const updatedAt = asTimestamp(raw.updatedAt, "breaker-updated-at");
  if (trippedAt !== null && updatedAt < trippedAt) throw new Error("breaker-epoch-corrupt:updated-before-tripped");
  return deepFreeze({
    schemaVersion: raw.schemaVersion,
    generation: raw.generation,
    tripped: raw.tripped,
    trippedAt,
    trippedReason,
    tripOperationId,
    rootIdentityHash,
    resetCommitment,
    updatedAt,
  });
}

// The implicit healthy breaker epoch used when no breaker epoch file exists
// (backward compatible with state roots created before the breaker epoch
// primitive). Generation 1 so the first trip and first reset produce a
// monotonically increasing counter without a special case.
export const IMPLICIT_LIVE_BREAKER_EPOCH = deepFreeze({
  schemaVersion: BREAKER_EPOCH_SCHEMA_VERSION,
  generation: 1,
  tripped: false,
  trippedAt: null,
  trippedReason: null,
  tripOperationId: null,
  rootIdentityHash: null,
  resetCommitment: null,
  updatedAt: 0,
});

export function breakerEpochFilePath(stateRoot) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("state-root-required");
  return path.join(stateRoot, BREAKER_EPOCH_FILENAME);
}

// Create a bound breaker-epoch manager over one state root and one set of
// injectable durable-filesystem dependencies. Reuses the same source-byte cache
// invalidation pattern as the root epoch: a peer's trip/reset write changes the
// bytes, so the cache invalidates automatically. `trip` is idempotent within a
// generation (a second trip at the same generation is a no-op). `reset` is the
// sole authenticated recovery path: it requires an exact operator-typed
// confirmation, an authenticated commitment, and advances the generation.
export function createBreakerEpochManager({
  stateRoot,
  durable = null,
  syncFile = null,
  syncDirectory = null,
  now = () => Date.now(),
} = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("state-root-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  const filePath = breakerEpochFilePath(stateRoot);
  const bound = durable ?? createDurableFilesystem({
    syncFile: syncFile ?? undefined,
    syncDirectory: syncDirectory ?? syncDirectoryFsync,
    probeDirectory: stateRoot,
  });
  let cachedSource = undefined;
  let cachedEpoch = null;

  function read() {
    let source;
    try { source = readRawBytes(filePath, BREAKER_EPOCH_MAX_BYTES, "breaker-epoch-corrupt"); } catch (error) {
      cachedSource = undefined;
      cachedEpoch = null;
      throw error;
    }
    if (source === null) {
      cachedSource = null;
      cachedEpoch = IMPLICIT_LIVE_BREAKER_EPOCH;
      return IMPLICIT_LIVE_BREAKER_EPOCH;
    }
    if (source === cachedSource && cachedEpoch) return cachedEpoch;
    const epoch = parseBreakerEpochRecord(source);
    cachedSource = source;
    cachedEpoch = epoch;
    return epoch;
  }

  function readTrippedReason() {
    const epoch = read();
    return epoch.tripped ? BREAKER_EPOCH_TRIPPED_REASON : null;
  }

  function isTripped() {
    try { return read().tripped; } catch { return true; }
  }

  function assertAuthoritativeCapability() {
    if (!bound.capability.available) {
      throw new Error(bound.capability.reason ?? DIRECTORY_FSYNC_UNAVAILABLE);
    }
  }

  function serialize(record) {
    return `${JSON.stringify(record)}\n`;
  }

  function buildResetCommitment(authentication) {
    if (!authentication || typeof authentication !== "object") {
      throw new TypeError("breaker-reset-authentication-required");
    }
    const rootIdentityHash = asOptionalHex64(authentication.rootIdentityHash ?? null, "breaker-auth-root-identity");
    const projectFingerprintHash = asOptionalHex64(authentication.projectFingerprintHash ?? null, "breaker-auth-project-fingerprint");
    const schemaVersion = asOptionalString(authentication.schemaVersion ?? null, "breaker-auth-schema-version", 64);
    const protocolVersion = asOptionalString(authentication.protocolVersion ?? null, "breaker-auth-protocol-version", 64);
    const nonce = typeof authentication.nonce === "string" && authentication.nonce.length >= 16 && authentication.nonce.length <= 128
      ? authentication.nonce
      : newNonce();
    const operatorAuthority = asOptionalString(authentication.operatorAuthority ?? null, "breaker-auth-operator", 64) ?? "operator";
    const committedAt = now();
    return {
      rootIdentityHash,
      projectFingerprintHash,
      schemaVersion,
      protocolVersion,
      nonceHash: hashJson(["breaker-epoch-reset-nonce-v1", nonce]),
      operatorAuthority,
      committedAt,
    };
  }

  // Durably trip the breaker. Idempotent within a generation: once tripped, a
  // second trip at the same generation is a no-op (the per-trip audit trail
  // stays in circuit-breaker records; the epoch is the cross-process open
  // truth). Audited by the caller.
  function trip({ reason = "breaker-tripped", operationId = null, rootIdentityHash = null } = {}) {
    assertAuthoritativeCapability();
    const current = read();
    if (current.tripped) return current;
    const timestamp = now();
    const generation = current.generation;
    const record = deepFreeze({
      schemaVersion: BREAKER_EPOCH_SCHEMA_VERSION,
      generation,
      tripped: true,
      trippedAt: timestamp,
      trippedReason: asOptionalReason(String(reason || "breaker-tripped"), "trip-reason"),
      tripOperationId: asOptionalString(operationId, "trip-operation-id", BREAKER_OPERATION_ID_MAX_LEN) ?? `breaker-trip-${generation}`,
      rootIdentityHash: rootIdentityHash ?? current.rootIdentityHash,
      resetCommitment: null,
      updatedAt: timestamp,
    });
    const source = serialize(record);
    if (!existsSync(filePath)) bound.durableCreateExclusive(filePath, source);
    else bound.durableReplaceFile(filePath, source);
    cachedSource = source;
    cachedEpoch = record;
    return record;
  }

  // Authenticated explicit reset: the sole recovery path from a tripped breaker
  // epoch. Requires the breaker to be tripped, an exact operator-typed
  // confirmation, and a full authenticated commitment (fresh root/project
  // identity, schema/protocol versions, one-use nonce, operator authority).
  // Advances the generation and clears tripped. Replay-safe: once reset
  // succeeds the breaker is not tripped, so a replayed reset (or any reset on a
  // healthy breaker) fails with a stable reason. Cannot be model-selected: the
  // exact confirmation and operator authority are only reachable through an
  // operator-typed command or a freshly validated native operation grant.
  function reset({ confirmation, authentication, rootIdentityHash = null } = {}) {
    assertAuthoritativeCapability();
    if (confirmation !== BREAKER_EPOCH_RESET_CONFIRMATION) {
      throw new Error("breaker-reset-confirmation-mismatch");
    }
    const current = read();
    if (!current.tripped) throw new Error("breaker-epoch-not-tripped");
    const commitment = buildResetCommitment(authentication);
    const timestamp = now();
    const generation = current.generation + 1;
    const record = deepFreeze({
      schemaVersion: BREAKER_EPOCH_SCHEMA_VERSION,
      generation,
      tripped: false,
      trippedAt: null,
      trippedReason: null,
      tripOperationId: null,
      rootIdentityHash: rootIdentityHash ?? current.rootIdentityHash,
      resetCommitment: commitment,
      updatedAt: timestamp,
    });
    const source = serialize(record);
    bound.durableReplaceFile(filePath, source);
    cachedSource = source;
    cachedEpoch = record;
    return record;
  }

  function invalidate() {
    cachedSource = undefined;
    cachedEpoch = null;
  }

  return Object.freeze({
    filePath,
    read,
    readTrippedReason,
    isTripped,
    trip,
    reset,
    invalidate,
    capability: bound.capability,
  });
}
