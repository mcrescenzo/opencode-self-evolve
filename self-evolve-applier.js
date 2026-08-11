import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  burnNonce,
  evaluateApplyAuthority,
  errorReasonCode,
  globalApplyIntentId,
  globalTargetLeaseKey,
  makeAuditEvent,
  makeCircuitBreaker,
  makeDecision,
  makeGlobalDecision,
  makeProposal,
  makeRollbackRecord,
  stripUndefined,
  transitionProposalState,
  wrapRecord,
} from "./self-evolve-schemas.js";
import {
  FATAL_CONTENT_ISSUES,
  hashSkillContent,
  isPathContained,
  rejectSymlinked,
  resolveGlobalRecommendationTarget,
  validateProposalTarget,
} from "./self-evolve-inventory.js";

const ACTOR = "self-evolve-applier";
const CLAIM_TTL_MS = 5 * 60 * 1000;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MUST_NOT_EXIST = "must-not-exist";

// Permanent capability boundary: this module only uses local filesystem and hashing
// primitives. It must never gain subprocess, source-control, remote I/O,
// package-manager, model/agent, dynamic-loader, or publication capabilities.

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorReason(error, fallback = "apply-failed") {
  if (error?.code === "EEXIST") return "target-exists";
  return errorReasonCode(error, fallback);
}

function recordsFrom(inventory) {
  if (Array.isArray(inventory)) return inventory;
  if (Array.isArray(inventory?.records)) return inventory.records;
  throw new TypeError("inventory-records-required");
}

function detailsHash(details) {
  return sha256(JSON.stringify(details));
}

function leaseKey(proposalId) {
  // openStore accepts only portable filename-safe lease keys.
  return `apply_${sha256(String(proposalId)).slice(0, 64)}`;
}

function ensureParent(target, root) {
  const parent = path.dirname(target);
  if (!isPathContained(parent, root) || rejectSymlinked(parent)) throw new Error("symlink-or-containment");
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
    const realRoot = fs.realpathSync(root);
    if (realRoot !== root || rejectSymlinked(root)) throw new Error("symlink-or-containment");
  }
  fs.mkdirSync(parent, { recursive: false, mode: DIR_MODE });
  const realParent = fs.realpathSync(parent);
  if (realParent !== parent || !isPathContained(realParent, root) || rejectSymlinked(parent)) throw new Error("symlink-or-containment");
  return parent;
}

function assertSafeParent(target, root) {
  const parent = path.dirname(target);
  const realParent = fs.realpathSync(parent);
  if (realParent !== parent || !isPathContained(realParent, root) || rejectSymlinked(parent)) throw new Error("symlink-or-containment");
}

function writeTemp(target, content, nonce) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.self-evolve-tmp-${nonce}`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    );
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } catch (writeError) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw writeError;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    const written = fs.readFileSync(temporary);
    if (hashSkillContent(written) !== hashSkillContent(content)) throw new Error("temp-write-mismatch");
  } catch (readbackError) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw readbackError;
  }
  return temporary;
}

function descriptorHash(descriptor) {
  const stat = fs.fstatSync(descriptor);
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (read === 0) throw new Error("global-temporary-file-invalid");
    offset += read;
  }
  return hashSkillContent(bytes);
}

function captureBoundTemporary(temporary, target, expectedHash) {
  if (typeof temporary !== "string" || temporary === "none"
      || path.dirname(temporary) !== path.dirname(target)
      || !path.basename(temporary).startsWith(`.${path.basename(target)}.self-evolve-tmp-`)) {
    throw new Error("global-temporary-file-invalid");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(temporary);
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || opened.dev !== current.dev || opened.ino !== current.ino
        || fs.realpathSync(temporary) !== temporary || descriptorHash(descriptor) !== expectedHash) {
      throw new Error("global-temporary-file-invalid");
    }
    return { descriptor, dev: opened.dev, ino: opened.ino, expectedHash, temporary };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function assertBoundTemporary(identity, { linkCount = 1 } = {}) {
  if (!identity || identity.descriptor === undefined) throw new Error("global-temporary-file-invalid");
  const opened = fs.fstatSync(identity.descriptor);
  const current = fs.lstatSync(identity.temporary);
  if (!opened.isFile() || opened.nlink !== linkCount || !current.isFile() || current.isSymbolicLink()
      || current.nlink !== linkCount || opened.dev !== identity.dev || opened.ino !== identity.ino
      || current.dev !== identity.dev || current.ino !== identity.ino
      || fs.realpathSync(identity.temporary) !== identity.temporary
      || descriptorHash(identity.descriptor) !== identity.expectedHash) {
    throw new Error("global-temporary-file-invalid");
  }
}

function unlinkExactBoundPath(filePath, identity) {
  if (!identity) return false;
  try {
    const current = fs.lstatSync(filePath);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
        || fs.realpathSync(filePath) !== filePath) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function verifiedNewSkillTemp(temporary, target, expectedHash) {
  if (typeof temporary !== "string" || temporary === "none"
      || path.dirname(temporary) !== path.dirname(target)
      || !path.basename(temporary).startsWith(`.${path.basename(target)}.self-evolve-tmp-`)) return false;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(temporary);
    return opened.isFile() && [1, 2].includes(opened.nlink)
      && current.isFile() && !current.isSymbolicLink() && current.nlink === opened.nlink
      && opened.dev === current.dev && opened.ino === current.ino
      && fs.realpathSync(temporary) === temporary
      && descriptorHash(descriptor) === expectedHash;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function captureNewSkillDirectory(target, canonicalRoot, expected = null) {
  const directory = path.dirname(target);
  let directoryDescriptor;
  try {
    directoryDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedDirectory = fs.fstatSync(directoryDescriptor, { bigint: true });
    const currentDirectory = fs.lstatSync(directory, { bigint: true });
    if (!openedDirectory.isDirectory() || !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink()
        || openedDirectory.dev !== currentDirectory.dev || openedDirectory.ino !== currentDirectory.ino
        || fs.realpathSync(directory) !== directory || !isPathContained(directory, canonicalRoot)
        || (expected !== null && (String(openedDirectory.dev) !== expected.directoryDevice
          || String(openedDirectory.ino) !== expected.directoryInode))) {
      throw new Error("new-global-skill-directory-ownership-invalid");
    }
    return {
      directory,
      directoryDescriptor,
      directoryDevice: String(openedDirectory.dev),
      directoryInode: String(openedDirectory.ino),
    };
  } catch (error) {
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function captureOwnedNewSkillDirectory(intent, target, canonicalRoot) {
  if (intent?.directoryDevice === null || intent?.directoryInode === null
      || intent?.directoryDevice === undefined || intent?.directoryInode === undefined) return null;
  return captureNewSkillDirectory(target, canonicalRoot, intent);
}

function captureLegacyOwnedNewSkillDirectory(intent, target, canonicalRoot) {
  const ownership = captureNewSkillDirectory(target, canonicalRoot);
  if (!ownership) return null;
  const marker = path.join(canonicalRoot, `.self-evolve-owner-${intent.intentId}`);
  let markerDescriptor;
  try {
    markerDescriptor = fs.openSync(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(markerDescriptor);
    const current = fs.lstatSync(marker);
    const binding = sha256(`self-evolve-global-new-skill-directory-v1\n${intent.intentId}\n${ownership.directoryDevice}\n${ownership.directoryInode}`);
    const expected = `self-evolve-global-new-skill-owner-v1\n${intent.intentId}\n${binding}\n`;
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || opened.dev !== current.dev || opened.ino !== current.ino || fs.realpathSync(marker) !== marker
        || fs.readFileSync(markerDescriptor, "utf8") !== expected) {
      throw new Error("new-global-skill-directory-ownership-invalid");
    }
    return {
      ownership,
      marker,
      markerDescriptor,
      markerDev: opened.dev,
      markerIno: opened.ino,
    };
  } catch (error) {
    if (markerDescriptor !== undefined) fs.closeSync(markerDescriptor);
    closeOwnedNewSkillDirectory(ownership);
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function closeOwnedNewSkillDirectory(ownership) {
  if (ownership?.directoryDescriptor !== undefined) fs.closeSync(ownership.directoryDescriptor);
}

function assertOwnedNewSkillDirectory(ownership) {
  if (!ownership) throw new Error("new-global-skill-directory-ownership-invalid");
  const openedDirectory = fs.fstatSync(ownership.directoryDescriptor, { bigint: true });
  const currentDirectory = fs.lstatSync(ownership.directory, { bigint: true });
  if (String(openedDirectory.dev) !== ownership.directoryDevice || String(openedDirectory.ino) !== ownership.directoryInode
      || String(currentDirectory.dev) !== ownership.directoryDevice || String(currentDirectory.ino) !== ownership.directoryInode
      || currentDirectory.isSymbolicLink()) {
    throw new Error("new-global-skill-directory-ownership-invalid");
  }
}

function createOwnedNewSkillDirectory(target, canonicalRoot) {
  const directory = path.dirname(target);
  try {
    fs.lstatSync(directory);
    throw new Error("new-global-skill-path-collision");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(directory, { recursive: false, mode: DIR_MODE });
  const ownership = captureNewSkillDirectory(target, canonicalRoot);
  if (!ownership) throw new Error("new-global-skill-directory-ownership-invalid");
  try {
    syncDirectory(canonicalRoot);
    assertOwnedNewSkillDirectory(ownership);
    return ownership;
  } catch (error) {
    closeOwnedNewSkillDirectory(ownership);
    throw error;
  }
}

function removeOwnedNewSkillDirectory(intent, target, canonicalRoot, priorOwnership = null) {
  const ownership = priorOwnership ?? captureOwnedNewSkillDirectory(intent, target, canonicalRoot);
  const closeAfter = ownership !== priorOwnership;
  if (!ownership) return false;
  try {
    assertOwnedNewSkillDirectory(ownership);
    try {
      fs.lstatSync(target);
      return false;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (fs.readdirSync(ownership.directory).length !== 0) return false;
    assertOwnedNewSkillDirectory(ownership);
    fs.rmdirSync(ownership.directory);
    syncDirectory(canonicalRoot);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTEMPTY"
        || error?.message === "new-global-skill-directory-ownership-invalid") return false;
    throw error;
  } finally {
    if (closeAfter) closeOwnedNewSkillDirectory(ownership);
  }
}

function readBoundGlobalTarget(target, canonicalRoot) {
  assertSafeParent(target, canonicalRoot);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || fs.realpathSync(target) !== target || !isPathContained(target, canonicalRoot)) {
    throw new Error("global-target-path-drift");
  }
  return fs.readFileSync(target);
}

function captureBoundGlobalTargetIdentity(target, canonicalRoot) {
  assertSafeParent(target, canonicalRoot);
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(target);
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || !current.isFile()
        || opened.dev !== current.dev || opened.ino !== current.ino || fs.realpathSync(target) !== target) {
      throw new Error("global-target-path-drift");
    }
    return { descriptor, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function assertBoundGlobalTargetIdentity(target, canonicalRoot, identity) {
  if (!identity || identity.descriptor === undefined) throw new Error("global-target-ownership-unproven");
  assertSafeParent(target, canonicalRoot);
  const opened = fs.fstatSync(identity.descriptor);
  const current = fs.lstatSync(target);
  if (!opened.isFile() || opened.nlink < 1 || !current.isFile() || current.isSymbolicLink() || current.nlink < 1
      || opened.dev !== identity.dev || opened.ino !== identity.ino
      || current.dev !== identity.dev || current.ino !== identity.ino
      || fs.realpathSync(target) !== target) {
    throw new Error("global-target-ownership-drift");
  }
}

export function createGlobalDecisionDomain({
  store,
  inventory,
  now = () => Date.now(),
  getSuppressors,
  forbiddenIdentityValues = [],
  projectSkillRoot = null,
  faultInjection,
} = {}) {
  const requiredStoreMethods = [
    "acquireGlobalLease", "acquireGlobalDecisionLease", "releaseGlobalLease", "getSettings", "readGlobalRecommendations", "readGlobalRecommendationContent",
    "readGlobalDecisionOutcomes", "readGlobalApplyIntents",
    "beginGlobalDecision", "revalidateGlobalDecisionIntent", "commitGlobalDecisionPublication", "writeGlobalSkillSnapshot", "advanceGlobalApplyIntent", "completeGlobalDecision",
    "failGlobalDecision", "readGlobalSkillSnapshots",
  ];
  if (!store || requiredStoreMethods.some((method) => typeof store[method] !== "function")) throw new TypeError("global-decision-store-required");
  if (!inventory || typeof inventory.resolveGlobalRecommendationTarget !== "function"
      || typeof inventory.validateProposalTarget !== "function") throw new TypeError("global-decision-inventory-required");
  if (typeof now !== "function") throw new TypeError("global-decision-clock-required");
  if (typeof getSuppressors !== "function") throw new TypeError("global-decision-suppressors-required");
  if (!Array.isArray(forbiddenIdentityValues) || forbiddenIdentityValues.length > 20
      || forbiddenIdentityValues.some((value) => typeof value !== "string" || !value || value.length > 1024 || value.includes("\0"))) {
    throw new TypeError("invalid-global-identity-firewall-context");
  }
  const identityFirewallValues = [...new Set(forbiddenIdentityValues.flatMap((value) => [
    value,
    hashSkillContent(value),
    hashSkillContent(JSON.stringify(value)),
  ]))].sort();

  function injectFault(point, details = {}) {
    if (typeof faultInjection === "function") faultInjection(point, details);
  }

  function releaseTargetLease(leaseKeyHash, ownerToken) {
    const released = store.releaseGlobalLease({ leaseKeyHash, ownerToken, nowMs: now() });
    return released?.ok
      ? { leaseStatus: "released" }
      : { leaseStatus: "degraded", leaseWarning: released?.reason ?? "global-lease-release-failed" };
  }

  function storeRequest(intent, lease, extra = {}) {
    return {
      intentId: intent.intentId,
      leaseKeyHash: lease.leaseKeyHash,
      ownerToken: lease.ownerToken,
      nowMs: now(),
      ...extra,
    };
  }

  function persistedOutcomeResult(outcome, { duplicate = true } = {}) {
    return outcome.state === "succeeded"
      ? { ok: true, duplicate, outcome }
      : { ok: false, duplicate, reason: outcome.reason, outcome };
  }

  function validateFreshApply(resolution, recommendation, content) {
    const proposal = {
      skillTarget: {
        canonicalRoot: resolution.target.canonicalRoot,
        relativePath: resolution.target.relativePath,
        currentHash: recommendation.targetBinding.currentHash,
      },
      proposedContent: content,
      proposedContentHash: recommendation.proposedContentHash,
    };
    const validated = inventory.validateProposalTarget(proposal, resolution.catalog.records);
    if (!validated.ok) {
      const detail = validated.errors.join(" ");
      if (/must not exist|collision/iu.test(detail)) throw new Error("global-target-collision");
      if (/hash|stale/iu.test(detail)) throw new Error("global-target-hash-drift");
      if (/growth budget/iu.test(detail)) throw new Error("growth-limit-exceeded");
      if (/unsafe|secret canaries/iu.test(detail)) throw new Error("unsafe-content");
      throw new Error("global-target-validation-failed");
    }
    return validated;
  }

  function rollbackFailedApply(intent, target, canonicalRoot, targetIdentity, { allowOwnedHashDrift = false } = {}) {
    let currentHash;
    try { currentHash = hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)); }
    catch (error) {
      if (error?.code === "ENOENT" && intent.priorHash === MUST_NOT_EXIST) return { ok: true, rolledBackHash: MUST_NOT_EXIST };
      return { ok: false, reason: errorReason(error, "global-rollback-read-failed") };
    }
    if (currentHash === intent.priorHash) return { ok: true, rolledBackHash: currentHash };
    if (currentHash !== intent.appliedHash && !allowOwnedHashDrift) return { ok: false, reason: "hash-drift" };
    try {
      if (intent.priorHash === MUST_NOT_EXIST) {
        injectFault("global-rollback-before-unlink", { intentId: intent.intentId });
        assertBoundGlobalTargetIdentity(target, canonicalRoot, targetIdentity);
        fs.unlinkSync(target);
        syncDirectory(path.dirname(target));
        removeOwnedNewSkillDirectory(intent, target, canonicalRoot);
        return { ok: true, rolledBackHash: MUST_NOT_EXIST };
      }
      const snapshot = store.readGlobalSkillSnapshots().find((item) => item.intentId === intent.intentId && item.snapshotId === intent.snapshotId);
      if (!snapshot) throw new Error("global-snapshot-missing");
      const prior = Buffer.from(snapshot.content, "base64");
      if (hashSkillContent(prior) !== intent.priorHash) throw new Error("global-snapshot-hash-mismatch");
      const temporary = writeTemp(target, prior, `${intent.intentId}-rollback`);
      try {
        injectFault("global-rollback-before-rename", { intentId: intent.intentId });
        assertBoundGlobalTargetIdentity(target, canonicalRoot, targetIdentity);
        fs.renameSync(temporary, target);
        syncDirectory(path.dirname(target));
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      if (hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)) !== intent.priorHash) throw new Error("global-rollback-readback-mismatch");
      return { ok: true, rolledBackHash: intent.priorHash };
    } catch (error) {
      return { ok: false, reason: errorReason(error, "global-rollback-failed") };
    }
  }

  function rollbackFailedUndo(intent, target, canonicalRoot, appliedContent, targetIdentity) {
    let currentHash;
    try { currentHash = hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)); }
    catch (error) {
      if (error?.code !== "ENOENT" || intent.targetKind !== "new-global-skill") {
        return { ok: false, reason: errorReason(error, "global-undo-rollback-read-failed") };
      }
      currentHash = MUST_NOT_EXIST;
    }
    if (currentHash === intent.appliedHash) return { ok: true, rolledBackHash: currentHash };
    if (currentHash !== intent.priorHash && !(intent.targetKind === "new-global-skill" && currentHash === MUST_NOT_EXIST)) {
      return { ok: false, reason: "hash-drift" };
    }
    try {
      if (hashSkillContent(appliedContent) !== intent.appliedHash) throw new Error("global-applied-content-mismatch");
      if (!fs.existsSync(path.dirname(target))) ensureParent(target, canonicalRoot);
      assertSafeParent(target, canonicalRoot);
      const temporary = writeTemp(target, appliedContent, `${intent.intentId}-undo-rollback`);
      try {
        if (intent.targetKind === "new-global-skill") {
          injectFault("global-undo-rollback-before-link", { intentId: intent.intentId });
          fs.linkSync(temporary, target);
        } else {
          injectFault("global-undo-rollback-before-rename", { intentId: intent.intentId });
          assertBoundGlobalTargetIdentity(target, canonicalRoot, targetIdentity);
          fs.renameSync(temporary, target);
        }
        if (intent.targetKind === "new-global-skill") fs.unlinkSync(temporary);
        syncDirectory(path.dirname(target));
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      if (hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)) !== intent.appliedHash) throw new Error("global-undo-rollback-readback-mismatch");
      return { ok: true, rolledBackHash: intent.appliedHash };
    } catch (error) {
      return { ok: false, reason: errorReason(error, "global-undo-rollback-failed") };
    }
  }

  function intentTarget(intent, recommendation) {
    const settings = store.getSettings();
    const policy = settings.global.globalRootPolicy;
    if (!policy || policy.rootSetHash !== recommendation.targetBinding.rootSetHash) throw new Error("stale-root-set");
    const root = policy.roots.find((item) => item.rootId === intent.rootId);
    if (!root || fs.realpathSync(root.canonicalPath) !== root.canonicalPath || rejectSymlinked(root.canonicalPath)) {
      throw new Error("root-not-validated");
    }
    const target = path.join(root.canonicalPath, intent.relativePath);
    if (!isPathContained(target, root.canonicalPath) || rejectSymlinked(target)) throw new Error("global-target-path-drift");
    return { target, canonicalRoot: root.canonicalPath };
  }

  function newSkillOwnerIntent(intent) {
    if (intent.action === "apply") return intent;
    return store.readGlobalApplyIntents().find((item) => item.action === "apply"
      && item.recommendationId === intent.recommendationId
      && item.targetKind === "new-global-skill"
      && item.state === "completed"
      && item.priorHash === intent.priorHash
      && item.appliedHash === intent.appliedHash) ?? null;
  }

  function migrateLegacyNewSkillOwnership(intent, target, canonicalRoot, lease) {
    const legacy = captureLegacyOwnedNewSkillDirectory(intent, target, canonicalRoot);
    if (!legacy) return null;
    let keepOwnership = false;
    try {
      if (intent.directoryDevice !== null && (intent.directoryDevice !== legacy.ownership.directoryDevice
          || intent.directoryInode !== legacy.ownership.directoryInode)) {
        throw new Error("new-global-skill-directory-ownership-invalid");
      }
      const bound = intent.directoryDevice === null
        ? store.advanceGlobalApplyIntent(storeRequest(intent, lease, {
          state: intent.state,
          directoryDevice: legacy.ownership.directoryDevice,
          directoryInode: legacy.ownership.directoryInode,
        }))
        : { ok: true, intent };
      if (!bound?.ok) throw new Error(bound?.reason ?? "global-directory-intent-bind-failed");
      assertOwnedNewSkillDirectory(legacy.ownership);
      if (!unlinkExactBoundPath(legacy.marker, { dev: legacy.markerDev, ino: legacy.markerIno })) {
        throw new Error("new-global-skill-legacy-marker-cleanup-failed");
      }
      syncDirectory(canonicalRoot);
      keepOwnership = true;
      return { intent: bound.intent, ownership: legacy.ownership };
    } finally {
      if (legacy.markerDescriptor !== undefined) fs.closeSync(legacy.markerDescriptor);
      if (!keepOwnership) closeOwnedNewSkillDirectory(legacy.ownership);
    }
  }

  function targetHashOrAbsent(target, canonicalRoot) {
    try { return hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)); }
    catch (error) {
      if (error?.code === "ENOENT") return MUST_NOT_EXIST;
      throw error;
    }
  }

  function expectedTemporaryPath(target, intent) {
    return path.join(path.dirname(target), `.${path.basename(target)}.self-evolve-tmp-${intent.intentId}`);
  }

  // A process killed inside a rollback leaves its rollback temporary behind in
  // the approved global root. The name is derived from this intent, so removing
  // exactly those two paths under the target lease clears the residue without
  // touching any external file, and it must run before a new-skill directory
  // cleanup that would otherwise fail with ENOTEMPTY.
  function removeOrphanRollbackTemporaries(intent, target) {
    const base = expectedTemporaryPath(target, intent);
    for (const suffix of ["-rollback", "-undo-rollback"]) {
      const orphan = `${base}${suffix}`;
      try {
        const current = fs.lstatSync(orphan);
        if (!current.isFile() || current.isSymbolicLink() || fs.realpathSync(orphan) !== orphan) continue;
        fs.unlinkSync(orphan);
        syncDirectory(path.dirname(orphan));
      } catch (error) {
        if (error?.code !== "ENOENT") return errorReason(error, "global-rollback-temporary-cleanup-failed");
      }
    }
    return null;
  }

  function recoverableIntentTemp(target, intent, expectedHash) {
    const temporary = expectedTemporaryPath(target, intent);
    try {
      assertSafeParent(target, path.dirname(path.dirname(target)));
      const stat = fs.lstatSync(temporary);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(temporary) !== temporary) return null;
      return hashSkillContent(fs.readFileSync(temporary)) === expectedHash ? temporary : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  function linkedNewSkillPublication(target, intent) {
    const temporary = expectedTemporaryPath(target, intent);
    const canonicalRoot = path.dirname(path.dirname(target));
    const ownership = captureOwnedNewSkillDirectory(intent, target, canonicalRoot);
    if (!ownership) return null;
    try {
      const targetStat = fs.lstatSync(target);
      const temporaryStat = fs.lstatSync(temporary);
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || !temporaryStat.isFile() || temporaryStat.isSymbolicLink()
          || targetStat.dev !== temporaryStat.dev || targetStat.ino !== temporaryStat.ino
          || targetStat.nlink !== 2 || temporaryStat.nlink !== 2
          || fs.realpathSync(target) !== target || fs.realpathSync(temporary) !== temporary
          || hashSkillContent(fs.readFileSync(target)) !== intent.appliedHash
          || hashSkillContent(fs.readFileSync(temporary)) !== intent.appliedHash) return null;
      return temporary;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    } finally {
      closeOwnedNewSkillDirectory(ownership);
    }
  }

  function completedNewSkillPublication(target, canonicalRoot, intent) {
    const ownership = captureOwnedNewSkillDirectory(intent, target, canonicalRoot);
    if (!ownership) return false;
    try {
      return hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)) === intent.appliedHash;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    } finally {
      closeOwnedNewSkillDirectory(ownership);
    }
  }

  function resetOwnedNewSkillPreparation(intent, recommendation) {
    const { target, canonicalRoot } = intentTarget(intent, recommendation);
    const directory = path.dirname(target);
    const ownership = captureOwnedNewSkillDirectory(intent, target, canonicalRoot);
    if (!ownership) {
      if (!fs.existsSync(directory)) return intent.directoryDevice !== null;
      throw new Error("new-global-skill-path-collision");
    }
    try {
      const entries = fs.readdirSync(directory);
      if (entries.length === 1 && entries[0] === path.basename(expectedTemporaryPath(target, intent))) {
        const temporary = recoverableIntentTemp(target, intent, intent.appliedHash);
        if (!temporary) throw new Error("new-global-skill-preparation-invalid");
        const temporaryIdentity = captureBoundTemporary(temporary, target, intent.appliedHash);
        try {
          if (!unlinkExactBoundPath(temporary, temporaryIdentity)) throw new Error("new-global-skill-preparation-invalid");
          syncDirectory(directory);
        } finally {
          fs.closeSync(temporaryIdentity.descriptor);
        }
      }
      if (!removeOwnedNewSkillDirectory(intent, target, canonicalRoot, ownership)) {
        throw new Error("new-global-skill-path-collision");
      }
      return true;
    } finally {
      closeOwnedNewSkillDirectory(ownership);
    }
  }

  function revalidateBeforePublication({ intent, recommendation, lease, target, canonicalRoot, temporary, temporaryIdentity, targetIdentity, directoryOwnership }) {
    const expectedTempHash = intent.action === "apply" ? intent.appliedHash : intent.priorHash;
    const needsTemporary = !(intent.action === "undo" && intent.targetKind === "new-global-skill");
    if (needsTemporary) {
      const expectedTemporary = expectedTemporaryPath(target, intent);
      if (!temporary || temporary !== expectedTemporary || path.basename(temporary) !== intent.temporaryName
          || recoverableIntentTemp(target, intent, expectedTempHash) !== temporary) {
        throw new Error("global-temporary-file-invalid");
      }
      assertBoundTemporary(temporaryIdentity);
    } else if (temporary || intent.temporaryName !== null) {
      throw new Error("global-temporary-file-invalid");
    }
    const settings = store.getSettings();
    const resolution = inventory.resolveGlobalRecommendationTarget(
      recommendation.targetBinding,
      settings.global.globalRootPolicy,
      {
        action: intent.action,
        proposedContentHash: recommendation.proposedContentHash,
        projectSkillRoot,
        ...(intent.action === "apply" && intent.targetKind === "new-global-skill" ? {
          preparedNewTarget: { temporaryName: intent.temporaryName, expectedHash: intent.appliedHash },
        } : {}),
      },
    );
    if (!resolution.ok) throw new Error(resolution.reason);
    if (resolution.binding.bindingHash !== intent.targetBindingHash
        || resolution.target.rootId !== intent.rootId
        || resolution.target.relativePath !== intent.relativePath
        || resolution.target.canonicalRoot !== canonicalRoot
        || resolution.target.absolutePath !== target) {
      throw new Error("global-target-binding-drift");
    }
    const expectedDiskHash = intent.action === "apply" ? intent.priorHash : intent.appliedHash;
    if (targetHashOrAbsent(target, canonicalRoot) !== expectedDiskHash) throw new Error("global-target-hash-drift");
    if (targetIdentity !== null) {
      const current = fs.lstatSync(target);
      if (current.dev !== targetIdentity.dev || current.ino !== targetIdentity.ino) throw new Error("global-target-ownership-drift");
    }
    if (intent.action === "apply" && intent.targetKind === "new-global-skill") {
      assertOwnedNewSkillDirectory(directoryOwnership);
      if (intent.directoryDevice !== directoryOwnership.directoryDevice
          || intent.directoryInode !== directoryOwnership.directoryInode) {
        throw new Error("new-global-skill-directory-ownership-invalid");
      }
    }
    const revalidated = store.revalidateGlobalDecisionIntent({
      intentId: intent.intentId,
      leaseKeyHash: lease.leaseKeyHash,
      ownerToken: lease.ownerToken,
      nowMs: now(),
      suppressors: getSuppressors(),
      forbiddenIdentityValues: identityFirewallValues,
    });
    if (!revalidated?.ok) throw new Error(revalidated?.reason ?? "global-decision-revalidation-failed");
    // Keep the descriptor-bound proof across the final fault seam. The
    // synchronous primitive rechecks before rename and verifies after link.
    if (needsTemporary) assertBoundTemporary(temporaryIdentity);
    if (targetHashOrAbsent(target, canonicalRoot) !== expectedDiskHash) throw new Error("global-target-hash-drift");
    if (targetIdentity !== null) assertBoundGlobalTargetIdentity(target, canonicalRoot, targetIdentity);
    if (intent.action === "apply" && intent.targetKind === "new-global-skill") assertOwnedNewSkillDirectory(directoryOwnership);
  }

  function publishBoundTemporary({ intent, target, canonicalRoot, temporaryIdentity, targetIdentity, directoryOwnership, publication }) {
    if (intent.action === "apply" && intent.targetKind === "new-global-skill") {
      assertOwnedNewSkillDirectory(directoryOwnership);
      try {
        fs.lstatSync(target);
        throw new Error("global-target-hash-drift");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      fs.linkSync(temporaryIdentity.temporary, target);
      const linked = fs.lstatSync(target);
      try {
        const opened = fs.fstatSync(temporaryIdentity.descriptor);
        const currentTemporary = fs.lstatSync(temporaryIdentity.temporary);
        assertOwnedNewSkillDirectory(directoryOwnership);
        if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 2
            || linked.dev !== temporaryIdentity.dev || linked.ino !== temporaryIdentity.ino
            || opened.nlink !== 2 || currentTemporary.nlink !== 2
            || currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino
            || hashSkillContent(fs.readFileSync(target)) !== temporaryIdentity.expectedHash) {
          throw new Error("global-temporary-file-invalid");
        }
      } catch (error) {
        unlinkExactBoundPath(target, { dev: linked.dev, ino: linked.ino });
        syncDirectory(path.dirname(target));
        throw error;
      }
      return;
    }
    assertBoundTemporary(temporaryIdentity);
    assertBoundGlobalTargetIdentity(target, canonicalRoot, targetIdentity);
    injectFault("global-apply-existing-after-temp-proof", {
      intentId: intent.intentId,
      temporary: temporaryIdentity.temporary,
    });
    fs.renameSync(temporaryIdentity.temporary, target);
    publication.occurred = true;
    publication.targetIdentity = {
      descriptor: temporaryIdentity.descriptor,
      dev: temporaryIdentity.dev,
      ino: temporaryIdentity.ino,
    };
    injectFault("global-apply-existing-after-rename", { intentId: intent.intentId, target });
    const current = fs.lstatSync(target);
    const opened = fs.fstatSync(temporaryIdentity.descriptor);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || current.dev !== temporaryIdentity.dev || current.ino !== temporaryIdentity.ino
        || opened.nlink !== 1 || fs.realpathSync(target) !== target
        || descriptorHash(temporaryIdentity.descriptor) !== temporaryIdentity.expectedHash) {
      throw new Error("global-temporary-file-invalid");
    }
  }

  function completePublishedIntent(intent, recommendation, lease) {
    const { target, canonicalRoot } = intentTarget(intent, recommendation);
    const expectedHash = intent.action === "apply" ? intent.appliedHash : intent.priorHash;
    let current = intent;
    if (current.state === "temp-written") {
      if (current.action === "apply" && current.targetKind === "new-global-skill") {
        if (!linkedNewSkillPublication(target, current)) return null;
      } else if (targetHashOrAbsent(target, canonicalRoot) !== expectedHash) return null;
      const published = store.advanceGlobalApplyIntent(storeRequest(current, lease, {
        state: "published",
        temporaryName: current.action === "apply" && current.targetKind === "new-global-skill" ? current.temporaryName : null,
      }));
      if (!published?.ok) return { ok: false, reason: published?.reason ?? "global-publication-intent-write-failed", recoveryRequired: true };
      current = published.intent;
    }
    if (current.state === "published") {
      if (current.action === "apply" && current.targetKind === "new-global-skill" && current.temporaryName !== null) {
        const linked = linkedNewSkillPublication(target, current);
        if (linked) {
          fs.unlinkSync(linked);
          injectFault("global-apply-after-temp-unlink", { intentId: current.intentId });
          syncDirectory(path.dirname(target));
        } else if (!completedNewSkillPublication(target, canonicalRoot, current)) {
          return { ok: false, reason: "global-new-skill-publication-ownership-invalid", recoveryRequired: true };
        }
      }
      if (targetHashOrAbsent(target, canonicalRoot) !== expectedHash) return null;
      const verified = store.advanceGlobalApplyIntent(storeRequest(current, lease, { state: "readback-verified", temporaryName: null }));
      if (!verified?.ok) return { ok: false, reason: verified?.reason ?? "global-readback-intent-write-failed", recoveryRequired: true };
      current = verified.intent;
    }
    if (current.state !== "readback-verified") return null;
    if (current.action === "undo" && current.targetKind === "new-global-skill" && fs.existsSync(path.dirname(target))) {
      try {
        const ownerIntent = newSkillOwnerIntent(current);
        if (ownerIntent) removeOwnedNewSkillDirectory(ownerIntent, target, canonicalRoot);
      } catch (error) {
        if (error?.code !== "ENOTEMPTY") return { ok: false, reason: errorReason(error, "global-undo-cleanup-failed"), recoveryRequired: true };
      }
    }
    const completed = store.completeGlobalDecision(storeRequest(current, lease));
    return completed?.ok
      ? { ok: true, duplicate: true, outcome: completed.outcome }
      : { ok: false, reason: completed?.reason ?? "global-decision-completion-failed", recoveryRequired: true };
  }

  async function decide({ action, decision } = {}) {
    let cleanDecision;
    try { cleanDecision = makeGlobalDecision(decision, { forbiddenIdentityValues: identityFirewallValues }); }
    catch (error) { return { ok: false, reason: errorReason(error, "invalid-global-decision") }; }
    if (!["apply", "undo"].includes(action)) return { ok: false, reason: "invalid-global-action" };
    const decisionAction = cleanDecision.priorState === "pending" && cleanDecision.newState === "approved"
      ? "apply"
      : cleanDecision.priorState === "applied" && cleanDecision.newState === "undo-approved"
        ? "undo"
        : null;
    if (decisionAction !== action) return { ok: false, reason: "global-action-decision-mismatch" };
    const intentId = (() => {
      try { return globalApplyIntentId(cleanDecision); } catch { return null; }
    })();
    if (intentId === null) return { ok: false, reason: "invalid-global-operator-decision" };
    const existingOutcome = store.readGlobalDecisionOutcomes().find((outcome) => outcome.intentId === intentId);
    const existingIntent = store.readGlobalApplyIntents().find((intent) => intent.intentId === intentId);
    if (existingOutcome && existingIntent && ["completed", "failed-closed"].includes(existingIntent.state)) {
      return persistedOutcomeResult(existingOutcome);
    }
    const acquired = store.acquireGlobalDecisionLease({
      action,
      decision: cleanDecision,
      nowMs: now(),
      ttlMs: CLAIM_TTL_MS,
      forbiddenIdentityValues: identityFirewallValues,
    });
    if (!acquired?.ok) {
      return acquired?.reason === "global-lease-busy"
        ? { ok: false, reason: "global-lease-busy", deferred: true }
        : { ok: false, reason: acquired?.reason ?? "global-lease-acquire-failed" };
    }
    const lease = acquired.lease;
    const recommendation = acquired.recommendation;
    const leaseKeyHash = lease.leaseKeyHash;
    let outcome;
    let temporary;
    let temporaryIdentity = null;
    let published = false;
    let preserveTemporaryForRecovery = false;
    let operationIntent;
    let operationTarget;
    let operationRoot;
    // Recovery of an already-published intent returns before the operation
    // bindings exist, so rollback-residue cleanup tracks the persisted intent
    // separately instead of depending on that later assignment.
    let residueIntent = null;
    let residueTarget = null;
    let operationTargetIdentity = null;
    let publishedTargetIdentity = null;
    let operationDirectoryOwnership = null;
    let operationDirectoryOwnerIntent = null;
    const publication = { occurred: false, targetIdentity: null };
    await Promise.resolve();
    try {
      const settings = store.getSettings();
      let persistedIntent = store.readGlobalApplyIntents().find((item) => item.intentId === intentId);
      if (existingOutcome && persistedIntent && !["completed", "failed-closed"].includes(persistedIntent.state)) {
        const reconciled = existingOutcome.state === "succeeded"
          ? store.completeGlobalDecision(storeRequest(persistedIntent, lease))
          : store.failGlobalDecision(storeRequest(persistedIntent, lease, {
            reason: existingOutcome.reason,
            forbiddenIdentityValues: identityFirewallValues,
          }));
        outcome = reconciled?.outcome
          ? persistedOutcomeResult(reconciled.outcome)
          : { ok: false, reason: reconciled?.reason ?? "global-outcome-reconciliation-failed", recoveryRequired: true };
        return outcome;
      }
      if (persistedIntent?.action === "apply" && persistedIntent.targetKind === "new-global-skill") {
        const persistedTarget = intentTarget(persistedIntent, recommendation);
        const migrated = migrateLegacyNewSkillOwnership(
          persistedIntent,
          persistedTarget.target,
          persistedTarget.canonicalRoot,
          lease,
        );
        if (migrated) {
          persistedIntent = migrated.intent;
          closeOwnedNewSkillDirectory(migrated.ownership);
        }
      }
      if (persistedIntent?.action === "apply" && persistedIntent.targetKind === "new-global-skill"
          && ["decision-committed", "snapshot-ready"].includes(persistedIntent.state)) {
        if (resetOwnedNewSkillPreparation(persistedIntent, recommendation)) {
          const cleared = store.advanceGlobalApplyIntent(storeRequest(persistedIntent, lease, {
            state: persistedIntent.state,
            directoryDevice: null,
            directoryInode: null,
          }));
          if (!cleared?.ok) throw new Error(cleared?.reason ?? "global-directory-intent-clear-failed");
          persistedIntent = cleared.intent;
        }
      }
      if (persistedIntent) {
        try {
          residueIntent = persistedIntent;
          residueTarget = intentTarget(persistedIntent, recommendation).target;
        } catch {
          residueIntent = null;
          residueTarget = null;
        }
      }
      if (persistedIntent && !["decision-pending", "decision-committed", "snapshot-ready"].includes(persistedIntent.state)) {
        const recovered = completePublishedIntent(persistedIntent, recommendation, lease);
        if (recovered) {
          outcome = recovered;
          return outcome;
        }
      }
      const resolution = inventory.resolveGlobalRecommendationTarget(
        recommendation.targetBinding,
        settings.global.globalRootPolicy,
        {
          action,
          proposedContentHash: recommendation.proposedContentHash,
          projectSkillRoot,
          ...(persistedIntent?.action === "apply" && persistedIntent.targetKind === "new-global-skill"
            && persistedIntent.state === "temp-written" ? {
              preparedNewTarget: { temporaryName: persistedIntent.temporaryName, expectedHash: persistedIntent.appliedHash },
            } : {}),
        },
      );
      if (!resolution.ok) throw new Error(resolution.reason);
      const content = store.readGlobalRecommendationContent(recommendation.recommendationId);
      if (typeof content !== "string" || hashSkillContent(content) !== recommendation.proposedContentHash) {
        throw new Error("global-recommendation-content-unavailable");
      }
      if (action === "apply") validateFreshApply(resolution, recommendation, content);
      const admitted = store.beginGlobalDecision({
        action,
        decision: cleanDecision,
        leaseKeyHash,
        ownerToken: lease.ownerToken,
        nowMs: now(),
        suppressors: getSuppressors(),
        forbiddenIdentityValues: identityFirewallValues,
      });
      if (admitted.outcome) {
        outcome = persistedOutcomeResult(admitted.outcome);
        return outcome;
      }
      if (!admitted?.ok) throw new Error(admitted?.reason ?? "global-decision-admission-failed");
      let intent = admitted.intent;
      const target = resolution.target.absolutePath;
      const canonicalRoot = resolution.target.canonicalRoot;
      operationIntent = intent;
      operationTarget = target;
      operationRoot = canonicalRoot;
      let priorContent;
      let targetIdentity = null;
      if (action === "apply" && intent.targetKind === "existing-global-skill") {
        priorContent = readBoundGlobalTarget(target, canonicalRoot);
        if (hashSkillContent(priorContent) !== intent.priorHash) throw new Error("global-target-hash-drift");
        targetIdentity = captureBoundGlobalTargetIdentity(target, canonicalRoot);
        operationTargetIdentity = targetIdentity;
      } else if (action === "apply") {
        injectFault("global-apply-before-new-directory-create", { intentId: intent.intentId });
        if (!fs.existsSync(path.dirname(target))) {
          operationDirectoryOwnership = createOwnedNewSkillDirectory(target, canonicalRoot);
        } else {
          operationDirectoryOwnership = captureOwnedNewSkillDirectory(intent, target, canonicalRoot);
          if (!operationDirectoryOwnership) throw new Error("new-global-skill-path-collision");
        }
        const bound = store.advanceGlobalApplyIntent(storeRequest(intent, lease, {
          state: intent.state,
          directoryDevice: operationDirectoryOwnership.directoryDevice,
          directoryInode: operationDirectoryOwnership.directoryInode,
        }));
        if (!bound?.ok) throw new Error(bound?.reason ?? "global-directory-intent-bind-failed");
        intent = bound.intent;
        operationIntent = intent;
        assertSafeParent(target, canonicalRoot);
      } else {
        if (hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)) !== intent.appliedHash) {
          throw new Error("global-undo-target-hash-drift");
        }
        targetIdentity = captureBoundGlobalTargetIdentity(target, canonicalRoot);
        operationTargetIdentity = targetIdentity;
        if (intent.targetKind === "new-global-skill") {
          operationDirectoryOwnerIntent = newSkillOwnerIntent(intent);
          const migrated = operationDirectoryOwnerIntent
            ? migrateLegacyNewSkillOwnership(operationDirectoryOwnerIntent, target, canonicalRoot, lease)
            : null;
          if (migrated) {
            operationDirectoryOwnerIntent = migrated.intent;
            operationDirectoryOwnership = migrated.ownership;
          } else {
            operationDirectoryOwnership = operationDirectoryOwnerIntent
              ? captureOwnedNewSkillDirectory(operationDirectoryOwnerIntent, target, canonicalRoot)
              : null;
          }
          if (!operationDirectoryOwnership) throw new Error("new-global-skill-directory-ownership-invalid");
        }
      }
      if (intent.state === "decision-committed") {
        const snapshotted = store.writeGlobalSkillSnapshot({
          ...storeRequest(intent, lease),
          forbiddenIdentityValues: identityFirewallValues,
          ...(priorContent === undefined ? {} : { content: priorContent }),
        });
        if (!snapshotted?.ok) throw new Error(snapshotted?.reason ?? "global-snapshot-write-failed");
        intent = snapshotted.intent;
        operationIntent = intent;
      }
      if (intent.state === "snapshot-ready") {
        injectFault("global-apply-before-temp-write", { intentId: intent.intentId });
        if (action === "apply") {
          assertSafeParent(target, canonicalRoot);
          temporary = recoverableIntentTemp(target, intent, intent.appliedHash) ?? writeTemp(target, content, intent.intentId);
          temporaryIdentity = captureBoundTemporary(temporary, target, intent.appliedHash);
        } else if (intent.targetKind === "existing-global-skill") {
          const snapshot = store.readGlobalSkillSnapshots().find((item) => item.snapshotId === intent.snapshotId);
          if (!snapshot || snapshot.priorHash !== intent.priorHash || snapshot.appliedHash !== intent.appliedHash) {
            throw new Error("global-snapshot-missing");
          }
          const restored = Buffer.from(snapshot.content, "base64");
          if (hashSkillContent(restored) !== intent.priorHash) throw new Error("global-snapshot-hash-mismatch");
          temporary = recoverableIntentTemp(target, intent, intent.priorHash) ?? writeTemp(target, restored, intent.intentId);
          temporaryIdentity = captureBoundTemporary(temporary, target, intent.priorHash);
        }
        injectFault("global-apply-after-temp-write", { intentId: intent.intentId });
        const tempName = temporary ? path.basename(temporary) : null;
        const tempMarked = store.advanceGlobalApplyIntent(storeRequest(intent, lease, { state: "temp-written", temporaryName: tempName }));
        if (!tempMarked?.ok) throw new Error(tempMarked?.reason ?? "global-temp-intent-write-failed");
        intent = tempMarked.intent;
        operationIntent = intent;
      }
      if (intent.state !== "temp-written") throw new Error("global-apply-intent-stage-mismatch");
      if (!(action === "undo" && intent.targetKind === "new-global-skill") && !temporary) {
        temporary = recoverableIntentTemp(target, intent, action === "apply" ? intent.appliedHash : intent.priorHash);
        if (!temporary || path.basename(temporary) !== intent.temporaryName) throw new Error("global-temporary-file-invalid");
        temporaryIdentity = captureBoundTemporary(temporary, target, action === "apply" ? intent.appliedHash : intent.priorHash);
      }
      assertSafeParent(target, canonicalRoot);
      injectFault("global-apply-before-publication", { intentId: intent.intentId });
      revalidateBeforePublication({ intent, recommendation, lease, target, canonicalRoot, temporary, temporaryIdentity, targetIdentity, directoryOwnership: operationDirectoryOwnership });
      injectFault("global-apply-after-temp-reproof", { intentId: intent.intentId });
      if (action === "undo" && intent.targetKind === "new-global-skill") {
        assertOwnedNewSkillDirectory(operationDirectoryOwnership);
        assertBoundGlobalTargetIdentity(target, canonicalRoot, targetIdentity);
        fs.unlinkSync(target);
      } else {
        publishBoundTemporary({ intent, target, canonicalRoot, temporaryIdentity, targetIdentity, directoryOwnership: operationDirectoryOwnership, publication });
        if (action === "apply" && intent.targetKind === "new-global-skill") preserveTemporaryForRecovery = true;
      }
      published = true;
      if (publication.targetIdentity) publishedTargetIdentity = publication.targetIdentity;
      if (!(action === "apply" && intent.targetKind === "new-global-skill")) temporary = undefined;
      syncDirectory(path.dirname(target));
      if (!publishedTargetIdentity && !(action === "apply" && intent.targetKind === "new-global-skill")
          && !(action === "undo" && intent.targetKind === "new-global-skill")) {
        publishedTargetIdentity = captureBoundGlobalTargetIdentity(target, canonicalRoot);
      }
      injectFault("global-apply-after-publication", { intentId: intent.intentId });
      const publishedIntent = store.commitGlobalDecisionPublication({
        intentId: intent.intentId,
        leaseKeyHash: lease.leaseKeyHash,
        ownerToken: lease.ownerToken,
        nowMs: now(),
        suppressors: getSuppressors(),
        forbiddenIdentityValues: identityFirewallValues,
        publishedTemporaryName: action === "apply" && intent.targetKind === "new-global-skill" ? intent.temporaryName : null,
      });
      if (!publishedIntent?.ok) {
        throw new Error(publishedIntent?.reason ?? "global-publication-intent-write-failed");
      }
      intent = publishedIntent.intent;
      operationIntent = intent;
      if (action === "apply" && intent.targetKind === "new-global-skill") {
        const linked = linkedNewSkillPublication(target, intent);
        if (!linked || linked !== temporary) {
          outcome = { ok: false, reason: "global-new-skill-publication-ownership-invalid", recoveryRequired: true };
          return outcome;
        }
        if (!unlinkExactBoundPath(linked, temporaryIdentity)) {
          outcome = { ok: false, reason: "global-new-skill-publication-ownership-invalid", recoveryRequired: true };
          return outcome;
        }
        injectFault("global-apply-after-temp-unlink", { intentId: intent.intentId });
        syncDirectory(path.dirname(target));
        preserveTemporaryForRecovery = false;
        temporary = undefined;
        publishedTargetIdentity = captureBoundGlobalTargetIdentity(target, canonicalRoot);
      }
      injectFault("global-apply-before-readback", { intentId: intent.intentId });
      if (action === "apply") {
        if (hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)) !== intent.appliedHash) throw new Error("global-readback-mismatch");
      } else if (intent.targetKind === "new-global-skill") {
        try {
          fs.lstatSync(target);
          throw new Error("global-undo-readback-mismatch");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      } else if (hashSkillContent(readBoundGlobalTarget(target, canonicalRoot)) !== intent.priorHash) {
        throw new Error("global-undo-readback-mismatch");
      }
      const verified = store.advanceGlobalApplyIntent(storeRequest(intent, lease, { state: "readback-verified", temporaryName: null }));
      if (!verified?.ok) {
        outcome = { ok: false, reason: verified?.reason ?? "global-readback-intent-write-failed", recoveryRequired: true };
        return outcome;
      }
      intent = verified.intent;
      operationIntent = intent;
      injectFault("global-apply-after-readback", { intentId: intent.intentId });
      if (action === "undo" && intent.targetKind === "new-global-skill") {
        injectFault("global-undo-before-directory-cleanup", { intentId: intent.intentId });
        removeOwnedNewSkillDirectory(operationDirectoryOwnerIntent, target, canonicalRoot, operationDirectoryOwnership);
        injectFault("global-undo-after-directory-cleanup", { intentId: intent.intentId });
      }
      const completed = store.completeGlobalDecision(storeRequest(intent, lease));
      if (!completed?.ok) {
        outcome = { ok: false, reason: completed?.reason ?? "global-decision-completion-failed", recoveryRequired: true };
        return outcome;
      }
      outcome = { ok: true, duplicate: completed.duplicate === true, outcome: completed.outcome };
      return outcome;
    } catch (error) {
      const reason = errorReason(error, "global-decision-failed");
      const intent = store.readGlobalApplyIntents?.().find((item) => item.intentId === intentId);
      if ((published || publication.occurred) && intent) {
        const root = store.getSettings().global.globalRootPolicy?.roots.find((item) => item.rootId === intent.rootId);
        const target = root ? path.join(root.canonicalPath, intent.relativePath) : null;
        const rollback = target
          ? action === "apply"
            ? rollbackFailedApply(
              intent,
              target,
              root.canonicalPath,
              publishedTargetIdentity ?? publication.targetIdentity,
              { allowOwnedHashDrift: publication.occurred && !published },
            )
            : rollbackFailedUndo(intent, target, root.canonicalPath, store.readGlobalRecommendationContent(intent.recommendationId), publishedTargetIdentity ?? publication.targetIdentity)
          : { ok: false, reason: "root-not-validated" };
        if (!rollback.ok) {
          outcome = { ok: false, reason: rollback.reason, recoveryRequired: true };
          return outcome;
        }
      }
      if (intent) {
        const failed = store.failGlobalDecision(storeRequest(intent, lease, {
          reason,
          forbiddenIdentityValues: identityFirewallValues,
        }));
        outcome = failed?.ok
          ? { ok: false, reason, outcome: failed.outcome }
          : { ok: false, reason, recoveryRequired: true, recoveryReason: failed?.reason };
      } else {
        outcome = { ok: false, reason };
      }
      return outcome;
    } finally {
      const targetDescriptors = new Set([
        operationTargetIdentity?.descriptor,
        publishedTargetIdentity?.descriptor,
        publication.targetIdentity?.descriptor,
      ].filter((descriptor) => descriptor !== undefined && descriptor !== temporaryIdentity?.descriptor));
      for (const descriptor of targetDescriptors) fs.closeSync(descriptor);
      if (temporary && temporaryIdentity && !preserveTemporaryForRecovery) unlinkExactBoundPath(temporary, temporaryIdentity);
      if (temporaryIdentity?.descriptor !== undefined) fs.closeSync(temporaryIdentity.descriptor);
      closeOwnedNewSkillDirectory(operationDirectoryOwnership);
      const cleanupIntent = operationIntent ?? residueIntent;
      const cleanupTarget = operationTarget ?? residueTarget;
      if (cleanupIntent && cleanupTarget) {
        const cleanupWarning = removeOrphanRollbackTemporaries(cleanupIntent, cleanupTarget);
        if (cleanupWarning && outcome && !outcome.cleanupWarning) outcome.cleanupWarning = cleanupWarning;
      }
      if (!published && action === "apply" && operationIntent?.targetKind === "new-global-skill" && operationTarget && operationRoot) {
        try {
          removeOwnedNewSkillDirectory(operationIntent, operationTarget, operationRoot);
        } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") {
            if (outcome) outcome.cleanupWarning = errorReason(error, "global-directory-cleanup-failed");
          }
        }
      }
      const released = releaseTargetLease(leaseKeyHash, lease.ownerToken);
      if (outcome) Object.assign(outcome, released);
    }
  }

  async function recover() {
    const outcomes = [];
    for (const intent of store.readGlobalApplyIntents()) {
      if (intent.action !== "apply" || intent.targetKind !== "new-global-skill") continue;
      const recommendation = store.readGlobalRecommendations().find((item) => item.recommendationId === intent.recommendationId);
      if (!recommendation) continue;
      const leaseKeyHash = globalTargetLeaseKey(recommendation.targetBinding);
      const acquired = store.acquireGlobalLease({ leaseKind: "target-write", leaseKeyHash, ttlMs: CLAIM_TTL_MS });
      if (!acquired?.ok) continue;
      try {
        const { target, canonicalRoot } = intentTarget(intent, recommendation);
        const migrated = migrateLegacyNewSkillOwnership(intent, target, canonicalRoot, acquired.lease);
        if (migrated) closeOwnedNewSkillDirectory(migrated.ownership);
      } catch {
        // Unproven legacy artifacts remain untouched and fail closed on use.
      } finally {
        releaseTargetLease(leaseKeyHash, acquired.lease.ownerToken);
      }
    }
    for (const intent of store.readGlobalApplyIntents()) {
      if (["completed", "failed-closed"].includes(intent.state)) continue;
      outcomes.push(await decide({ action: intent.action, decision: intent.decision }));
    }
    return outcomes;
  }

  return Object.freeze({ decide, recover });
}

export function createApplier({ store, inventory, privacy, now = () => Date.now(), faultInjection } = {}) {
  if (!store || typeof store.acquireLease !== "function" || typeof store.appendRecord !== "function") throw new TypeError("store-required");
  if (!privacy || typeof privacy.scanForForbiddenContent !== "function") throw new TypeError("privacy-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  const initialInventoryRecords = recordsFrom(inventory);
  const snapshotRoot = typeof store.snapshotRoot === "string" ? path.resolve(store.snapshotRoot) : null;
  const held = new Map();
  const priorBreakers = typeof store.readRecords === "function" ? store.readRecords("circuit-breaker") : [];
  let breakerOpen = priorBreakers.at(-1)?.payload?.open === true;
  let tripCount = priorBreakers.at(-1)?.payload?.tripCount ?? 0;
  let closed = false;

  function injectFault(point) {
    if (typeof faultInjection === "function") faultInjection(point);
  }

  function appendAudit(kind, proposalId, details) {
    const timestamp = now();
    const clean = stripUndefined(details);
    const event = makeAuditEvent({
      id: sha256(JSON.stringify({ kind, proposalId, timestamp, clean, nonce: randomBytes(12).toString("hex") })),
      kind,
      proposalId,
      actor: ACTOR,
      timestamp,
      payloadHash: detailsHash(clean),
      details: clean,
    });
    const appended = store.appendRecord(wrapRecord("audit-event", event, timestamp));
    if (!appended?.ok) throw new Error(appended?.reason ?? "audit-write-failed");
    return event.id;
  }

  function auditFailure(proposal, reason, extra = {}) {
    try {
      return appendAudit("apply", proposal.id, {
        state: "failed",
        reason,
        target: proposal?.skillTarget?.relativePath ?? "unknown",
        "readback-verified": false,
        ...extra,
      });
    } catch {
      return undefined;
    }
  }

  function auditWarning(proposal, action, reason, extra = {}) {
    try {
      return appendAudit("apply", proposal.id, {
        state: "warning",
        action,
        reason,
        target: proposal?.skillTarget?.relativePath ?? "unknown",
        "readback-verified": false,
        ...extra,
      });
    } catch {
      return undefined;
    }
  }

  function tripCritical(proposalId, reason, details = {}) {
    breakerOpen = true;
    tripCount += 1;
    try {
      appendAudit("rollback", proposalId, { state: "critical", reason, "readback-verified": false, ...details });
    } catch {}
    try {
      const timestamp = now();
      const breaker = makeCircuitBreaker({ open: true, openedAt: timestamp, reason, tripCount });
      store.appendRecord(wrapRecord("circuit-breaker", breaker, timestamp));
    } catch {}
  }

  function snapshotPath(proposalId, appliedHash) {
    if (!snapshotRoot) throw new Error("snapshot-root-unavailable");
    return path.join(snapshotRoot, `${encodeURIComponent(String(proposalId))}.${appliedHash}.before`);
  }

  function createSnapshot(proposalId, appliedHash, priorContent) {
    const fileName = `${encodeURIComponent(String(proposalId))}.${appliedHash}.before`;
    if (typeof store.writeSnapshot === "function") return store.writeSnapshot(fileName, priorContent);
    const destination = snapshotPath(proposalId, appliedHash);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: DIR_MODE });
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, priorContent, { flag: "wx", mode: FILE_MODE });
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return destination;
  }

  function release(key, nonce, operation, proposalId) {
    let result;
    try {
      result = store.releaseLease(key, nonce);
    } catch (error) {
      result = { ok: false, reason: errorReason(error, "lease-release-error") };
    }
    if (result?.ok) {
      held.delete(key);
      return { leaseStatus: "released" };
    }
    const reason = result?.reason ?? "lease-release-error";
    try {
      appendAudit("lease", proposalId ?? "unknown", {
        state: "warning",
        action: "lease-release",
        operation,
        reason,
        leaseKey: key,
        "readback-verified": false,
      });
    } catch {}
    return { leaseStatus: "degraded", leaseWarning: reason };
  }

  function quotaAvailable(proposal) {
    if (typeof privacy.inspectScope !== "function") return true;
    try {
      return privacy.inspectScope(proposal.projectFingerprint).quotaFraction <= 1;
    } catch {
      return false;
    }
  }

  function decisionApproved(proposal, decision) {
    if (!decision) return false;
    if (proposal.state === "approved") {
      try {
        const clean = makeDecision(decision);
        const schemaProposal = Object.fromEntries([
          "id", "projectFingerprint", "clusterId", "skillTarget", "proposedContentHash", "rationaleText",
          "synthesizedAt", "synthesizerModelId", "criticScore", "criticPassed", "validDeterministic",
          "state", "injectionFlagged", "decisionVersion", "burnedNonceHashes",
        ].filter((key) => proposal[key] !== undefined).map((key) => [key, proposal[key]]));
        const approved = makeProposal(schemaProposal);
        const nonceHash = burnNonce(clean);
        const burnedNonceHashes = [...approved.burnedNonceHashes];
        const burnedIndex = burnedNonceHashes.lastIndexOf(nonceHash);
        if (burnedIndex >= 0) burnedNonceHashes.splice(burnedIndex, 1);
        const prior = makeProposal({
          ...approved,
          state: "pending",
          decisionVersion: approved.decisionVersion - 1,
          burnedNonceHashes,
        });
        const transitioned = transitionProposalState(prior, clean, clean.timestamp);
        return transitioned.ok
          && transitioned.state.state === "approved"
          && transitioned.state.decisionVersion === approved.decisionVersion
          && transitioned.state.skillTarget.currentHash === approved.skillTarget.currentHash;
      } catch {
        if (proposal.skillTarget.currentHash === MUST_NOT_EXIST) return false;
        try {
          const clean = makeDecision(decision);
          return clean.proposalId === proposal.id
            && clean.targetHash === proposal.skillTarget.currentHash
            && clean.proposedContentHash === proposal.proposedContentHash
            && clean.decisionVersion === proposal.decisionVersion
            && clean.priorState === "pending"
            && clean.newState === "approved";
        } catch {
          return false;
        }
      }
    }
    const schemaProposal = Object.fromEntries([
      "id", "projectFingerprint", "clusterId", "skillTarget", "proposedContentHash", "rationaleText",
      "synthesizedAt", "synthesizerModelId", "criticScore", "criticPassed", "validDeterministic",
      "state", "injectionFlagged", "decisionVersion", "burnedNonceHashes",
    ].filter((key) => proposal[key] !== undefined).map((key) => [key, proposal[key]]));
    const transitioned = transitionProposalState(schemaProposal, decision, now());
    return transitioned.ok && transitioned.state.state === "approved";
  }

  async function applyProposal({ proposal, decision, actor = ACTOR, mode, headless = false } = {}) {
    if (closed) return { ok: false, reason: "applier-closed" };
    if (breakerOpen) return { ok: false, reason: "circuit-breaker-open", auditId: auditFailure(proposal ?? { id: "unknown", skillTarget: {} }, "circuit-breaker-open") };
    if (!proposal?.id || !proposal?.skillTarget) return { ok: false, reason: "invalid-proposal" };

    const inventoryRecords = typeof inventory?.discoverSkills === "function" && Array.isArray(inventory?.canonicalRoots)
      ? inventory.discoverSkills(inventory.canonicalRoots)
      : initialInventoryRecords;
    const allowlisted = inventoryRecords.some((item) => item.canonicalRoot === proposal.skillTarget.canonicalRoot)
      || inventory?.canonicalRoots?.includes(proposal.skillTarget.canonicalRoot) === true;
    const releaseGatesPassed = proposal.criticPassed === true && proposal.validDeterministic === true && proposal.injectionFlagged !== true;
    let killSwitchActive = false;
    try { killSwitchActive = store.getSettings?.().global.killSwitchActive === true; } catch { killSwitchActive = true; }
    const authority = evaluateApplyAuthority({
      mode,
      decisionApproved: decisionApproved(proposal, decision),
      allowlisted,
      releaseGatesPassed,
      headless,
      killSwitchActive,
    });
    if (!authority.allowed) return { ok: false, reason: authority.reason, auditId: auditFailure(proposal, authority.reason, { mode: String(mode ?? "manual") }) };
    if (!quotaAvailable(proposal)) return { ok: false, reason: "storage-quota-exceeded", auditId: auditFailure(proposal, "storage-quota-exceeded") };

    const key = leaseKey(proposal.id);
    const acquired = store.acquireLease(key, { ttlMs: CLAIM_TTL_MS, actor: ACTOR });
    if (!acquired?.ok) {
      if (acquired?.reason === "lease-busy") return { ok: false, reason: "lease-busy", deferred: true };
      return { ok: false, reason: "lease-error", auditId: auditFailure(proposal, acquired?.reason ?? "lease-error") };
    }
    held.set(key, acquired.nonce);

    // Yield with the claim held so same-process callers observe at-most-once behavior.
    await Promise.resolve();
    let temporary;
    let renamed = false;
    let snapshot;
    let pendingAuditId;
    let outcome;
    let appliedHash;
    const isNew = proposal.skillTarget.currentHash === MUST_NOT_EXIST;
    const target = path.resolve(proposal.skillTarget.canonicalRoot, proposal.skillTarget.relativePath);
    try {
      const validated = validateProposalTarget(proposal, inventoryRecords);
      if (!validated.ok) {
        const joined = validated.errors.join(" ");
        const reason = joined.includes("must not exist") ? "target-exists"
          : /hash|stale/iu.test(joined) ? "stale-hash"
            : joined.includes("growth budget") ? "growth-limit-exceeded"
              : /secret canaries|unsafe/iu.test(joined) ? "unsafe-content" : "validation-failed";
        throw new Error(reason);
      }
      const forbidden = privacy.scanForForbiddenContent(proposal.proposedContent);
      const fatalForbidden = forbidden.issues.filter((issue) => FATAL_CONTENT_ISSUES.has(issue));
      if (fatalForbidden.length) throw new Error("unsafe-content");
      const contentAdvisories = [...new Set([
        ...validated.contentAdvisories,
        ...forbidden.issues.filter((issue) => !FATAL_CONTENT_ISSUES.has(issue)),
      ])].join(", ").slice(0, 512);

      let priorContent = null;
      if (isNew) {
        if (!fs.existsSync(path.dirname(target))) ensureParent(target, proposal.skillTarget.canonicalRoot);
        assertSafeParent(target, proposal.skillTarget.canonicalRoot);
      } else {
        priorContent = fs.readFileSync(target);
        if (hashSkillContent(priorContent) !== proposal.skillTarget.currentHash) throw new Error("stale-hash");
      }

      injectFault("apply-before-temp-parent-check");
      assertSafeParent(target, proposal.skillTarget.canonicalRoot);
      temporary = writeTemp(target, proposal.proposedContent, acquired.nonce);
      injectFault("apply-after-temp-write");
      appliedHash = hashSkillContent(proposal.proposedContent);
      if (appliedHash !== proposal.proposedContentHash) throw new Error("proposed-hash-mismatch");
      if (priorContent) snapshot = createSnapshot(proposal.id, appliedHash, priorContent);

      assertSafeParent(target, proposal.skillTarget.canonicalRoot);
      let killSwitchBeforeRename = false;
      try { killSwitchBeforeRename = store.getSettings?.().global.killSwitchActive === true; } catch { killSwitchBeforeRename = true; }
      if (killSwitchBeforeRename) {
        try {
          appendAudit("kill-switch", proposal.id, {
            state: "downgraded",
            reason: "kill-switch",
            target: proposal.skillTarget.relativePath,
            storedMode: String(mode ?? "manual"),
            effectiveMode: "manual",
          });
        } catch {}
        throw new Error("kill-switch");
      }
      injectFault("apply-before-pending-audit");
      pendingAuditId = appendAudit("apply", proposal.id, {
        state: "applied",
        target,
        canonicalRoot: proposal.skillTarget.canonicalRoot,
        priorHash: isNew ? MUST_NOT_EXIST : proposal.skillTarget.currentHash,
        appliedHash,
        actor: String(actor),
        mode,
        leaseNonce: acquired.nonce,
        snapshot: snapshot ?? "none",
        temporary,
        temporaryHash: appliedHash,
        contentAdvisories,
        "readback-verified": false,
      });
      injectFault("apply-after-pending-audit");
      assertSafeParent(target, proposal.skillTarget.canonicalRoot);
      if (isNew) {
        fs.linkSync(temporary, target);
        renamed = true;
        injectFault("apply-after-new-target-link");
        try {
          fs.unlinkSync(temporary);
          temporary = undefined;
        } catch (cleanupError) {
          auditWarning(proposal, "temp-cleanup-failed", errorReason(cleanupError, "temp-cleanup-failed"), { target, temporary });
        }
      } else {
        fs.renameSync(temporary, target);
        renamed = true;
        temporary = undefined;
      }
      injectFault("apply-after-publication");

      const readback = fs.readFileSync(target);
      if (hashSkillContent(readback) !== proposal.proposedContentHash) {
        const rolledBack = rollbackFromAudit({
          proposalId: proposal.id,
          target,
          canonicalRoot: proposal.skillTarget.canonicalRoot,
          appliedHash,
          priorHash: isNew ? MUST_NOT_EXIST : proposal.skillTarget.currentHash,
          snapshot: snapshot ?? "none",
          actor: ACTOR,
          reason: "readback-mismatch",
        });
        if (!rolledBack.ok && !rolledBack.rollbackCompleted) tripCritical(proposal.id, rolledBack.reason, { target, appliedHash });
        outcome = { ok: false, reason: "readback-mismatch", auditId: pendingAuditId };
        return outcome;
      }
      const auditId = appendAudit("apply", proposal.id, {
        state: "readback-verified",
        target,
        canonicalRoot: proposal.skillTarget.canonicalRoot,
        priorHash: isNew ? MUST_NOT_EXIST : proposal.skillTarget.currentHash,
        appliedHash,
        actor: String(actor),
        mode,
        leaseNonce: acquired.nonce,
        snapshot: snapshot ?? "none",
        temporary: "none",
        temporaryHash: appliedHash,
        contentAdvisories,
        "readback-verified": true,
      });
      injectFault("apply-after-readback-audit");
      outcome = { ok: true, appliedHash, auditId };
      return outcome;
    } catch (error) {
      const reason = errorReason(error);
      if (renamed) {
        const rolledBack = rollbackFromAudit({
          proposalId: proposal.id,
          target,
          canonicalRoot: proposal.skillTarget.canonicalRoot,
          appliedHash,
          priorHash: isNew ? MUST_NOT_EXIST : proposal.skillTarget.currentHash,
          snapshot: snapshot ?? "none",
          actor: ACTOR,
          reason,
        });
        if (!rolledBack.ok && !rolledBack.rollbackCompleted) tripCritical(proposal.id, rolledBack.reason, { target, appliedHash });
        else pendingAuditId = rolledBack.auditId;
      }
      outcome = { ok: false, reason, auditId: pendingAuditId ?? auditFailure(proposal, reason, { target }) };
      return outcome;
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true });
      if (snapshot && !pendingAuditId) fs.rmSync(snapshot, { force: true });
      const releaseResult = release(key, acquired.nonce, "apply", proposal.id);
      if (outcome) Object.assign(outcome, releaseResult);
    }
  }

  function latestVerifiedApply(proposalId) {
    const records = store.readRecords("audit-event");
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const event = records[index].payload;
      if (event.kind === "apply" && event.proposalId === proposalId && event.details?.["readback-verified"] === true) return event;
    }
    return null;
  }

  function persistRollbackCompletion({ proposalId, target, appliedHash, rolledBackHash, snapshot, actor, reason }) {
    const auditId = appendAudit("rollback", proposalId, {
      state: "rolled-back",
      target,
      appliedHash,
      rolledBackHash,
      actor: String(actor),
      reason,
      "readback-verified": true,
    });
    const rollback = makeRollbackRecord({ proposalId, appliedHash, rolledBackAt: now(), reason });
    const recorded = store.appendRecord(wrapRecord("rollback-record", rollback, now()));
    if (!recorded?.ok) throw new Error(recorded?.reason ?? "rollback-record-write-failed");
    if (snapshot && snapshot !== "none") fs.rmSync(snapshot, { force: true });
    return { ok: true, rolledBackHash, auditId };
  }

  function reconcileCompletedRollback({ proposalId, target, appliedHash, priorHash, snapshot, actor, reason }, rolledBackHash) {
    try {
      return persistRollbackCompletion({ proposalId, target, appliedHash, rolledBackHash, snapshot, actor, reason });
    } catch (error) {
      return { ok: false, reason: errorReason(error, "rollback-failed"), rollbackCompleted: true, rolledBackHash };
    }
  }

  function rollbackFromAudit({ proposalId, target, canonicalRoot, appliedHash, priorHash, snapshot, actor, reason }) {
    let rolledBackHash;
    let rollbackCompleted = false;
    try {
      const current = fs.readFileSync(target);
      if (hashSkillContent(current) !== appliedHash) return { ok: false, reason: "hash-drift" };
      if (priorHash === MUST_NOT_EXIST) {
        fs.unlinkSync(target);
        rolledBackHash = MUST_NOT_EXIST;
      } else {
        if (!snapshot || snapshot === "none" || !fs.existsSync(snapshot)) throw new Error("snapshot-missing");
        const prior = fs.readFileSync(snapshot);
        if (hashSkillContent(prior) !== priorHash) throw new Error("snapshot-hash-mismatch");
        assertSafeParent(target, canonicalRoot ?? path.dirname(path.dirname(target)));
        const temporary = writeTemp(target, prior, randomBytes(12).toString("hex"));
        try { fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
        rolledBackHash = hashSkillContent(fs.readFileSync(target));
        if (rolledBackHash !== priorHash) throw new Error("rollback-readback-mismatch");
      }
      rollbackCompleted = true;
      return persistRollbackCompletion({ proposalId, target, appliedHash, rolledBackHash, snapshot, actor, reason });
    } catch (error) {
      const failure = errorReason(error, "rollback-failed");
      return { ok: false, reason: failure, ...(rollbackCompleted ? { rollbackCompleted: true, rolledBackHash } : {}) };
    }
  }

  function rollbackApplied({ proposalId, actor = ACTOR, reason = "requested" } = {}) {
    const audit = latestVerifiedApply(proposalId);
    if (!audit) return { ok: false, reason: "applied-audit-not-found" };
    const key = leaseKey(proposalId);
    const existingNonce = held.get(key);
    const acquired = existingNonce
      ? { ok: true, nonce: existingNonce }
      : store.acquireLease(key, { ttlMs: CLAIM_TTL_MS, actor: `${ACTOR}-rollback` });
    if (!acquired?.ok) {
      return acquired?.reason === "lease-busy"
        ? { ok: false, reason: "lease-busy", deferred: true }
        : { ok: false, reason: acquired?.reason ?? "lease-error" };
    }
    const acquiredHere = !existingNonce;
    if (acquiredHere) held.set(key, acquired.nonce);
    let outcome;
    try {
      try {
        const currentHash = hashSkillContent(fs.readFileSync(audit.details.target));
        if (currentHash !== audit.details.appliedHash) {
          if (currentHash === audit.details.priorHash) {
            outcome = reconcileCompletedRollback({ proposalId, actor, reason, ...audit.details }, currentHash);
            return outcome;
          }
          appendAudit("rollback", proposalId, {
            state: "refused",
            target: audit.details.target,
            appliedHash: audit.details.appliedHash,
            actor: String(actor),
            reason: "hash-drift",
            "readback-verified": false,
          });
          tripCritical(proposalId, "hash-drift", { target: audit.details.target, appliedHash: audit.details.appliedHash });
          outcome = { ok: false, reason: "hash-drift" };
          return outcome;
        }
      } catch (error) {
        if (error?.code === "ENOENT" && audit.details.priorHash === MUST_NOT_EXIST) {
          outcome = reconcileCompletedRollback({ proposalId, actor, reason, ...audit.details }, MUST_NOT_EXIST);
          return outcome;
        }
        const failure = errorReason(error, "rollback-failed");
        tripCritical(proposalId, failure, { target: audit.details.target, appliedHash: audit.details.appliedHash });
        outcome = { ok: false, reason: failure };
        return outcome;
      }
      outcome = rollbackFromAudit({ proposalId, actor, reason, ...audit.details });
      if (!outcome.ok && !outcome.rollbackCompleted) tripCritical(proposalId, outcome.reason, { target: audit.details.target, appliedHash: audit.details.appliedHash });
      return outcome;
    } finally {
      if (acquiredHere) {
        const releaseResult = release(key, acquired.nonce, "rollback", proposalId);
        if (outcome) Object.assign(outcome, releaseResult);
      }
    }
  }

  function recoverPending() {
    const outcomes = [];
    for (const record of store.getRecoveryPending()) {
      const audit = record.payload;
      const details = audit.details;
      const key = leaseKey(audit.proposalId);
      const acquired = store.acquireLease(key, { ttlMs: CLAIM_TTL_MS, actor: `${ACTOR}-recovery` });
      if (!acquired?.ok) {
        outcomes.push(acquired?.reason === "lease-busy"
          ? { ok: true, deferred: true, proposalId: audit.proposalId, reason: "lease-busy" }
          : { ok: false, proposalId: audit.proposalId, reason: acquired?.reason ?? "lease-error" });
        continue;
      }
      held.set(key, acquired.nonce);
      let outcome;
      try {
        let currentHash;
        try { currentHash = hashSkillContent(fs.readFileSync(details.target)); }
        catch (error) {
          if (error?.code !== "ENOENT" || details.priorHash !== MUST_NOT_EXIST) throw error;
          const temporary = details.temporary;
          if (verifiedNewSkillTemp(temporary, details.target, details.temporaryHash)) fs.unlinkSync(temporary);
          const auditId = appendAudit("rollback", audit.proposalId, { ...details, state: "rolled-back", rolledBackHash: MUST_NOT_EXIST, reason: "recovery-found-target-absent", "readback-verified": true });
          outcome = { ok: false, proposalId: audit.proposalId, reason: "apply-not-published", rolledBackHash: MUST_NOT_EXIST, auditId };
          outcomes.push(outcome);
          continue;
        }
        if (currentHash === details.appliedHash) {
          if (details.priorHash === MUST_NOT_EXIST && verifiedNewSkillTemp(details.temporary, details.target, details.temporaryHash)) {
            try {
              fs.unlinkSync(details.temporary);
            } catch (error) {
              const reason = errorReason(error, "temporary-unlink-failed");
              auditWarning({ id: audit.proposalId }, "temp-cleanup-failed", reason, { target: details.target, temporary: details.temporary, recovery: true });
              try { fs.rmSync(details.temporary, { force: true }); } catch {}
            }
          }
          const auditId = appendAudit("apply", audit.proposalId, { ...details, state: "readback-verified", temporary: "none", "readback-verified": true, recovery: true });
          outcome = { ok: true, proposalId: audit.proposalId, appliedHash: currentHash, auditId };
          outcomes.push(outcome);
        } else if (currentHash === details.priorHash) {
          const auditId = appendAudit("rollback", audit.proposalId, { ...details, state: "rolled-back", rolledBackHash: currentHash, reason: "recovery-found-prior-content", "readback-verified": true });
          if (details.snapshot && details.snapshot !== "none") fs.rmSync(details.snapshot, { force: true });
          outcome = { ok: true, proposalId: audit.proposalId, rolledBackHash: currentHash, auditId };
          outcomes.push(outcome);
        } else if (details.priorHash === MUST_NOT_EXIST) {
          tripCritical(audit.proposalId, "target-collision", { target: details.target, appliedHash: details.appliedHash });
          outcome = { ok: false, proposalId: audit.proposalId, reason: "target-collision" };
          outcomes.push(outcome);
        } else {
          const rollback = rollbackFromAudit({ proposalId: audit.proposalId, actor: ACTOR, reason: "startup-recovery", ...details });
          if (!rollback.ok && !rollback.rollbackCompleted) tripCritical(audit.proposalId, rollback.reason, { target: details.target, appliedHash: details.appliedHash });
          outcome = { ok: false, proposalId: audit.proposalId, reason: rollback.reason };
          outcomes.push(outcome);
        }
      } catch (error) {
        const reason = errorReason(error, "recovery-failed");
        tripCritical(audit.proposalId, reason, { target: details.target, appliedHash: details.appliedHash });
        outcome = { ok: false, proposalId: audit.proposalId, reason };
        outcomes.push(outcome);
      } finally {
        const releaseResult = release(key, acquired.nonce, "recovery", audit.proposalId);
        if (outcome) Object.assign(outcome, releaseResult);
      }
    }
    return outcomes;
  }

  function close() {
    if (closed) return { ok: true, unreleased: [] };
    const unreleased = [];
    for (const [key, nonce] of held) {
      const status = release(key, nonce, "close");
      if (status.leaseStatus !== "released") unreleased.push({ key, reason: status.leaseWarning });
    }
    if (unreleased.length) return { ok: false, unreleased };
    closed = true;
    return { ok: true, unreleased: [] };
  }

  function getApplyLeaseStatus(proposalId) {
    return store.getLeaseStatus?.(leaseKey(proposalId)) ?? { state: "absent", held: false, reclaimable: false, lease: null };
  }

  return Object.freeze({ applyProposal, rollbackApplied, recoverPending, getApplyLeaseStatus, circuitBreakerOpen: () => breakerOpen, close });
}
