import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  evaluateApplyAuthority,
  makeAuditEvent,
  makeCircuitBreaker,
  makeDecision,
  makeRollbackRecord,
  transitionProposalState,
  wrapRecord,
} from "./self-evolve-schemas.js";
import {
  hashSkillContent,
  isPathContained,
  rejectSymlinked,
  scanForSecretCanaries,
  scanForUnsafeContent,
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
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.split(":", 1)[0] || fallback;
}

function recordsFrom(inventory) {
  if (Array.isArray(inventory)) return inventory;
  if (Array.isArray(inventory?.records)) return inventory.records;
  throw new TypeError("inventory-records-required");
}

function resultFlag(result) {
  return result?.flagged === true || result?.ok === false;
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
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, FILE_MODE);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const written = fs.readFileSync(temporary);
  if (hashSkillContent(written) !== hashSkillContent(content)) {
    fs.rmSync(temporary, { force: true });
    throw new Error("temp-write-mismatch");
  }
  return temporary;
}

export function createApplier({ store, inventory, privacy, now = () => Date.now(), faultInjection } = {}) {
  if (!store || typeof store.acquireLease !== "function" || typeof store.appendRecord !== "function") throw new TypeError("store-required");
  if (!privacy || typeof privacy.scanForForbiddenContent !== "function") throw new TypeError("privacy-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  const inventoryRecords = recordsFrom(inventory);
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
    const clean = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
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
      if (proposal.skillTarget.currentHash === MUST_NOT_EXIST) {
        return decision.proposalId === proposal.id
          && decision.targetHash === MUST_NOT_EXIST
          && decision.proposedContentHash === proposal.proposedContentHash
          && decision.newState === "approved"
          && typeof decision.actor === "string" && decision.actor.length > 0
          && typeof decision.nonce === "string" && decision.nonce.length > 0
          && Number.isSafeInteger(decision.decisionVersion)
          && Number.isSafeInteger(decision.timestamp);
      }
      try {
        const clean = makeDecision(decision);
        return clean.proposalId === proposal.id
          && clean.targetHash === proposal.skillTarget.currentHash
          && clean.proposedContentHash === proposal.proposedContentHash
          && clean.newState === "approved";
      } catch {
        return false;
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
    const target = path.resolve(proposal.skillTarget.canonicalRoot, proposal.skillTarget.relativePath);
    try {
      const validated = validateProposalTarget(proposal, inventoryRecords);
      if (!validated.ok) {
        const joined = validated.errors.join(" ");
        const reason = joined.includes("must not exist") ? "target-exists"
          : joined.includes("hash") || joined.includes("stale") ? "stale-hash"
            : joined.includes("growth budget") ? "growth-limit-exceeded" : "validation-failed";
        throw new Error(reason);
      }
      for (const scan of [scanForSecretCanaries(proposal.proposedContent), scanForUnsafeContent(proposal.proposedContent), privacy.scanForForbiddenContent(proposal.proposedContent)]) {
        if (resultFlag(scan)) throw new Error("unsafe-content");
      }

      const isNew = proposal.skillTarget.currentHash === MUST_NOT_EXIST;
      let priorContent = null;
      if (isNew) {
        if (!fs.existsSync(path.dirname(target))) ensureParent(target, proposal.skillTarget.canonicalRoot);
        assertSafeParent(target, proposal.skillTarget.canonicalRoot);
      } else {
        priorContent = fs.readFileSync(target);
        if (hashSkillContent(priorContent) !== proposal.skillTarget.currentHash) throw new Error("stale-hash");
      }

      temporary = writeTemp(target, proposal.proposedContent, acquired.nonce);
      injectFault("apply-after-temp-write");
      const appliedHash = hashSkillContent(proposal.proposedContent);
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
        priorHash: isNew ? MUST_NOT_EXIST : proposal.skillTarget.currentHash,
        appliedHash,
        actor: String(actor),
        mode,
        leaseNonce: acquired.nonce,
        snapshot: snapshot ?? "none",
        temporary,
        temporaryHash: appliedHash,
        "readback-verified": false,
      });
      injectFault("apply-after-pending-audit");
      assertSafeParent(target, proposal.skillTarget.canonicalRoot);
      if (isNew) {
        fs.linkSync(temporary, target);
        fs.unlinkSync(temporary);
      } else {
        fs.renameSync(temporary, target);
      }
      temporary = undefined;
      renamed = true;
      injectFault("apply-after-publication");

      const readback = fs.readFileSync(target);
      if (hashSkillContent(readback) !== proposal.proposedContentHash) {
        const rolledBack = rollbackFromAudit({
          proposalId: proposal.id,
          target,
          appliedHash,
          priorHash: isNew ? MUST_NOT_EXIST : proposal.skillTarget.currentHash,
          snapshot: snapshot ?? "none",
          actor: ACTOR,
          reason: "readback-mismatch",
        });
        if (!rolledBack.ok) tripCritical(proposal.id, rolledBack.reason, { target, appliedHash });
        outcome = { ok: false, reason: "readback-mismatch", auditId: pendingAuditId };
        return outcome;
      }
      const auditId = appendAudit("apply", proposal.id, {
        state: "readback-verified",
        target,
        priorHash: isNew ? MUST_NOT_EXIST : proposal.skillTarget.currentHash,
        appliedHash,
        actor: String(actor),
        mode,
        leaseNonce: acquired.nonce,
        snapshot: snapshot ?? "none",
        temporary: "none",
        temporaryHash: appliedHash,
        "readback-verified": true,
      });
      injectFault("apply-after-readback-audit");
      outcome = { ok: true, appliedHash, auditId };
      return outcome;
    } catch (error) {
      const reason = errorReason(error);
      if (renamed) {
        const rolledBack = rollbackApplied({ proposalId: proposal.id, actor: ACTOR, reason });
        if (!rolledBack.ok) tripCritical(proposal.id, rolledBack.reason, { target });
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

  function rollbackFromAudit({ proposalId, target, appliedHash, priorHash, snapshot, actor, reason }) {
    try {
      const current = fs.readFileSync(target);
      if (hashSkillContent(current) !== appliedHash) return { ok: false, reason: "hash-drift" };
      let rolledBackHash;
      if (priorHash === MUST_NOT_EXIST) {
        fs.unlinkSync(target);
        rolledBackHash = MUST_NOT_EXIST;
      } else {
        if (!snapshot || snapshot === "none" || !fs.existsSync(snapshot)) throw new Error("snapshot-missing");
        const prior = fs.readFileSync(snapshot);
        if (hashSkillContent(prior) !== priorHash) throw new Error("snapshot-hash-mismatch");
        assertSafeParent(target, path.dirname(path.dirname(target)));
        const temporary = writeTemp(target, prior, randomBytes(12).toString("hex"));
        try { fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
        rolledBackHash = hashSkillContent(fs.readFileSync(target));
        if (rolledBackHash !== priorHash) throw new Error("rollback-readback-mismatch");
        fs.rmSync(snapshot, { force: true });
      }
      appendAudit("rollback", proposalId, { state: "rolled-back", target, appliedHash, rolledBackHash, actor: String(actor), reason, "readback-verified": true });
      const rollback = makeRollbackRecord({ proposalId, appliedHash, rolledBackAt: now(), reason });
      store.appendRecord(wrapRecord("rollback-record", rollback, now()));
      return { ok: true, rolledBackHash };
    } catch (error) {
      const failure = errorReason(error, "rollback-failed");
      return { ok: false, reason: failure };
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
        const failure = errorReason(error, "rollback-failed");
        tripCritical(proposalId, failure, { target: audit.details.target, appliedHash: audit.details.appliedHash });
        outcome = { ok: false, reason: failure };
        return outcome;
      }
      outcome = rollbackFromAudit({ proposalId, actor, reason, ...audit.details });
      if (!outcome.ok) tripCritical(proposalId, outcome.reason, { target: audit.details.target, appliedHash: audit.details.appliedHash });
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
          if (typeof temporary === "string" && temporary !== "none" && path.dirname(temporary) === path.dirname(details.target)
            && path.basename(temporary).startsWith(`.${path.basename(details.target)}.self-evolve-tmp-`) && fs.existsSync(temporary)
            && hashSkillContent(fs.readFileSync(temporary)) === details.temporaryHash) fs.unlinkSync(temporary);
          const auditId = appendAudit("rollback", audit.proposalId, { ...details, state: "rolled-back", rolledBackHash: MUST_NOT_EXIST, reason: "recovery-found-target-absent", "readback-verified": true });
          outcome = { ok: false, proposalId: audit.proposalId, reason: "apply-not-published", rolledBackHash: MUST_NOT_EXIST, auditId };
          outcomes.push(outcome);
          continue;
        }
        if (currentHash === details.appliedHash) {
          const auditId = appendAudit("apply", audit.proposalId, { ...details, state: "readback-verified", "readback-verified": true, recovery: true });
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
          if (!rollback.ok) tripCritical(audit.proposalId, rollback.reason, { target: details.target, appliedHash: details.appliedHash });
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
