import { readSessionMessages } from "./self-evolve-client.js";
import { extractTargetLogicalNames, partIsExcludedFromEvidence } from "./self-evolve-observation.js";
import { latestByLogicalId } from "./self-evolve-schemas.js";

const DEFAULT_MESSAGE_LIMIT = 120;
const DEFAULT_DRAIN_MAX_PER_PASS = 4;
const DEFAULT_DRAIN_MIN_PASSIVE_PER_SYNTHESIS = 2;
const DRAIN_LEASE_KEY = "self-evolve-candidate-drain";
const DRAIN_LEASE_TTL_MS = 5 * 60 * 1000;

export function resolveClusterTargetName(cluster) {
  const counts = new Map();
  for (const item of cluster?.observations ?? []) {
    const name = item?.structuredFields?.targetLogicalName ?? null;
    if (typeof name === "string" && name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size) {
    const ranked = [...counts].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
    if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
      return { name: ranked[0][0], via: "observation-plurality" };
    }
  }
  return { name: null, via: "new-global-skill" };
}

function assertWorkActive(signal) {
  if (!signal?.aborted) return;
  const error = new Error("autonomous-work-cancelled");
  error.name = "AbortError";
  throw error;
}

function messageParts(message) {
  const parts = message?.parts ?? message?.info?.parts ?? message?.message?.parts;
  return Array.isArray(parts) ? parts : null;
}

function messageText(message, parts = messageParts(message)) {
  const text = Array.isArray(parts)
    ? parts.map((part) => part?.text ?? part?.content ?? "").filter(Boolean).join("\n")
    : "";
  return parts?.length ? text : String(message?.text ?? message?.content ?? message?.info?.text ?? "");
}

function messageRole(message) {
  return message?.role ?? message?.info?.role ?? message?.type ?? "message";
}

function selfEvolveOutput(message) {
  const agent = message?.agent ?? message?.info?.agent;
  const parts = messageParts(message) ?? [];
  return agent === "self-evolve-synthesizer"
    || agent === "self-evolve-critic"
    || (Array.isArray(parts) && parts.some((part) => part?.metadata?.source === "self-evolve-plugin"));
}

function metadataMessages(messages, privacy, automationStamp = null) {
  return messages.flatMap((message) => {
    if (partIsExcludedFromEvidence(message)) return [];
    const parts = messageParts(message);
    const evidenceParts = parts?.filter((part) => !partIsExcludedFromEvidence(part)) ?? null;
    if (parts?.length && evidenceParts.length === 0) return [];
    const role = messageRole(message);
    const text = messageText(message, evidenceParts).trim();
    const command = role === "user" ? text.match(/^\s*(\/[A-Za-z0-9][A-Za-z0-9_-]*)\b/u)?.[1] : null;
    const excerpt = text && privacy?.scrubExcerpt ? privacy.scrubExcerpt({ text }, { automationStamp }) : null;
    const contentScan = text && privacy?.scanForForbiddenContent ? privacy.scanForForbiddenContent(text) : null;
    const targetNames = extractTargetLogicalNames([{ parts: evidenceParts ?? [] }]);
    const base = {
      role,
      ...(command ? { commandName: command.toLowerCase() } : {}),
      ...(excerpt?.ok ? { content: excerpt.redacted } : {}),
      injectionFlagged: contentScan?.issues?.some((issue) => issue === "prompt-injection-marker" || issue === "authority-escalation") === true,
      isSelfEvolveOutput: selfEvolveOutput(message),
      ...(targetNames.length ? { parts: targetNames.map((name) => ({ type: "tool", tool: "skill", state: { input: { name } } })) } : {}),
    };
    const toolParts = (evidenceParts ?? []).filter((part) =>
      part?.type === "tool" && (part?.state?.status === "error" || part?.state?.error));
    return [base, ...toolParts.map((part) => ({
      role: "tool",
      toolName: String(part.tool ?? part.name ?? "tool").slice(0, 128),
      toolError: String(part.state?.error ?? part.state?.status ?? "error").slice(0, 128),
      isSelfEvolveOutput: base.isSelfEvolveOutput,
    }))];
  });
}

function currentProposal(store, proposalId) {
  return latestByLogicalId(store.readRecords("proposal")).get(proposalId)?.payload ?? null;
}

function pendingProposal(store, projectFingerprint) {
  return [...latestByLogicalId(store.readRecords("proposal")).values()]
    .map((record) => record.payload)
    .findLast((proposal) => proposal.projectFingerprint === projectFingerprint && proposal.state === "pending") ?? null;
}

function latestCursor(store, sessionIDHash) {
  return store.readRecords("episode-cursor").filter((record) => record.payload.sessionIDHash === sessionIDHash).at(-1) ?? null;
}

function auditSince(store, start) {
  return store.readRecords("audit-event").slice(start).map((record) => record.payload);
}

function receiptFields(receipt) {
  const structuredFields = {
    receiptType: receipt.receiptType,
    scopeFingerprint: receipt.scopeFingerprint,
    occurrences: receipt.occurrences,
    eventKind: receipt.receiptType,
    deterministicOutcome: true,
    targetLogicalName: receipt.targetLogicalName,
  };
  if (receipt.receiptType === "repeated-command") structuredFields.commandSignatureHash = receipt.signatureHash;
  if (receipt.receiptType === "repeated-tool-error") structuredFields.toolErrorCode = receipt.signatureHash.slice(0, 128);
  if (receipt.receiptType === "repeated-manual-procedure") structuredFields.procedureFingerprint = receipt.signatureHash;
  if (receipt.receiptType === "repeated-clarification") structuredFields.clarificationCategory = "repeated-user-clarification";
  return structuredFields;
}

function signatureForCluster(cluster, item, hashSignature) {
  for (const signatureHash of item.receiptIds ?? []) {
    const key = [
      item.structuredFields?.receiptType,
      item.projectFingerprint,
      item.structuredFields?.scopeFingerprint,
      item.structuredFields?.targetLogicalName ?? "<untargeted>",
      signatureHash,
    ].join("\n");
    if (hashSignature(key) === cluster.id) return signatureHash;
  }
  return null;
}

function proposalText(proposal) {
  return [
    `Self-evolve proposal ${proposal.id} is ready for explicit approval.`,
    `Target: ${proposal.skillTarget.relativePath}`,
    `Rationale: ${proposal.rationaleText}`,
    `Review: /self-evolve review ${proposal.id}`,
    "Use /self-evolve inbox or review to obtain the current exact approval tuple.",
    "No files were applied while creating this recommendation.",
  ].join("\n");
}

function noEligibleText(eligibility) {
  const reasons = [...new Set(eligibility.flatMap((item) => item.reasons ?? []))];
  return `Self-evolve recorded bounded observations but no evidence cluster is eligible. ${reasons.length ? `Unmet gates: ${reasons.join(", ")}. ` : ""}No files were applied.`;
}

function episodeLineage({ sessionID, projectFingerprint, rootSessionID, rootSessionIDHash, originKind, trigger, options, schemas, observation }) {
  const suppliedRootSessionID = rootSessionID ?? options.rootSessionID;
  const suppliedRootSessionIDHash = rootSessionIDHash ?? options.rootSessionIDHash;
  const suppliedOriginKind = originKind ?? options.originKind;
  if (suppliedOriginKind === "unknown" || suppliedRootSessionIDHash === schemas.UNKNOWN_ROOT_LINEAGE_HASH) {
    return { resolved: false, rootLineageHash: schemas.UNKNOWN_ROOT_LINEAGE_HASH, originKind: "unknown", reason: "scheduler-root-unresolved" };
  }
  if (typeof suppliedRootSessionID === "string" && suppliedRootSessionID
    && suppliedRootSessionIDHash === observation.hashRootLineage(suppliedRootSessionID)
    && schemas.ORIGIN_KINDS.includes(suppliedOriginKind)
    && suppliedOriginKind !== "unknown"
    && ((suppliedOriginKind === "delegated") === (suppliedRootSessionID !== sessionID))) {
    return {
      resolved: true,
      rootSessionID: suppliedRootSessionID,
      rootLineageHash: suppliedRootSessionIDHash,
      originKind: suppliedOriginKind,
    };
  }
  const triggerKind = typeof trigger === "string" ? trigger : trigger?.kind;
  const passiveTrigger = ["scheduler", "idle", "recovery", "session.idle", "session.status", "session.compacted"].includes(triggerKind);
  return observation.resolveRootLineage({
    sessionID,
    projectFingerprint,
    sessions: options.sessionAncestry ?? [{
      sessionID,
      projectFingerprint,
      ...(!passiveTrigger ? { owned: false, trustworthy: true } : {}),
    }],
    preferredRootSessionID: suppliedRootSessionID,
    preferredRootSessionIDHash: suppliedRootSessionIDHash,
    maxDepth: options.rootLineageMaxDepth ?? observation.ROOT_LINEAGE_MAX_DEPTH,
  });
}

export function createPipeline({ store, inventory, privacy, synthesis, applier, commands, schemas, observation, now = () => Date.now() }) {
  if (!store || !inventory || !privacy || !synthesis || !applier || !commands || !schemas || !observation) {
    throw new TypeError("pipeline-dependencies-required");
  }
  if (typeof now !== "function") throw new TypeError("now-must-be-function");

  const pendingSynthesisLeaseCleanups = new Map();
  const globalCatalogs = new WeakMap();

  function append(kind, payload, timestamp = now(), automationStamp = null) {
    const saved = store.appendRecord(
      schemas.wrapRecord(kind, payload, timestamp),
      { automationStamp },
    );
    if (!saved?.ok) throw new Error(saved?.reason ?? `${kind}-write-failed`);
    return saved;
  }

  function appendAudit(action, subjectId, details = {}, { synthesisFinalization = false, automationStamp = null } = {}) {
    const timestamp = now();
    const clean = { action, subjectId: String(subjectId), ...details };
    const payloadHash = observation.hashSignature(JSON.stringify(clean));
    const event = schemas.makeAuditEvent({
      id: observation.hashSignature(JSON.stringify({ timestamp, payloadHash, clean })),
      kind: "decision",
      actor: "self-evolve-pipeline",
      timestamp,
      payloadHash,
      details: clean,
    });
    const envelope = schemas.wrapRecord("audit-event", event, timestamp);
    const saved = synthesisFinalization && typeof store.appendSynthesisFinalizationAudit === "function"
      ? store.appendSynthesisFinalizationAudit(envelope)
      : store.appendRecord(envelope, { automationStamp });
    if (!saved?.ok) throw new Error(saved?.reason ?? "audit-event-write-failed");
    return event;
  }

  function appendDiagnosticAudit(action, subjectId, details = {}, automationStamp = null) {
    try { return appendAudit(action, subjectId, details, { automationStamp }); }
    catch { return null; }
  }

  function outcomeReason(status, reason) {
    if (status === "accepted") return "accepted";
    if (status === "no-change") return "valid-no-change";
    if (status === "critic-rejected") return "critic-rejected";
    const value = String(reason ?? "").toLowerCase();
    if (value === "proposal-content-unavailable") return "proposal-content-unavailable";
    if (value.includes("proposal-content")) return "proposal-content-persistence-failed";
    if (value.includes("timeout")) return "timeout";
    if (value.includes("json") || value.includes("malformed") || value.includes("missing") || value.includes("unexpected")) return "malformed-output";
    if (value.includes("validation") || value.includes("hash") || value.includes("target") || value.includes("unsafe") || value.includes("secret")) return "deterministic-validation-failed";
    return value.includes("critic") ? "critic-failed" : value ? "synthesis-failed" : "unknown-failure";
  }

  function leaseCleanupIdentity(attempt, lease) {
    const expectedKey = synthesis.synthesisLeaseKey?.(attempt);
    if (!expectedKey || typeof lease?.nonce !== "string" || !lease.nonce) return null;
    const leaseNonceHash = observation.hashSignature(lease.nonce);
    return {
      leaseKey: expectedKey,
      leaseNonceHash,
      cleanupKey: `${attempt.outcomeId}:${leaseNonceHash}`,
      bindingMatches: lease?.key === expectedKey,
    };
  }

  function hasLeaseCleanupEvent(action, outcomeId, leaseNonceHash) {
    return store.readRecords("audit-event").some((record) =>
      record.payload?.details?.action === action
      && record.payload.details.outcomeId === outcomeId
      && record.payload.details.leaseNonceHash === leaseNonceHash);
  }

  function warnLeaseCleanup(attempt, lease, reason, expectedLeaseActor) {
    try {
      const identity = leaseCleanupIdentity(attempt, lease);
      if (!identity) return { ok: false, reason: "synthesis-lease-binding-unavailable" };
      if (hasLeaseCleanupEvent("synthesis-lease-cleanup-warning", attempt.outcomeId, identity.leaseNonceHash)) {
        return { ok: true, duplicate: true, identity };
      }
      appendAudit("synthesis-lease-cleanup-warning", attempt.outcomeId, {
        outcomeId: attempt.outcomeId,
        leaseKey: identity.leaseKey,
        leaseNonceHash: identity.leaseNonceHash,
        cleanupOwner: "self-evolve-pipeline",
        expectedLeaseActor: String(expectedLeaseActor).slice(0, 128),
        expectedLeasePid: process.pid,
        retryable: true,
        reason: String(reason ?? "synthesis-lease-release-failed").slice(0, 128),
      }, { synthesisFinalization: true });
      if (!hasLeaseCleanupEvent("synthesis-lease-cleanup-warning", attempt.outcomeId, identity.leaseNonceHash)) {
        return { ok: false, reason: "synthesis-lease-cleanup-warning-readback-failed" };
      }
      return { ok: true, identity };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  function resolveLeaseCleanup(attempt, identity, reason) {
    try {
      if (!identity
          || !hasLeaseCleanupEvent("synthesis-lease-cleanup-warning", attempt.outcomeId, identity.leaseNonceHash)
          || hasLeaseCleanupEvent("synthesis-lease-cleanup-resolved", attempt.outcomeId, identity.leaseNonceHash)) return;
      appendAudit("synthesis-lease-cleanup-resolved", attempt.outcomeId, {
        outcomeId: attempt.outcomeId,
        leaseKey: identity.leaseKey,
        leaseNonceHash: identity.leaseNonceHash,
        cleanupOwner: "self-evolve-pipeline",
        retryable: false,
        reason: String(reason ?? "released").slice(0, 128),
      }, { synthesisFinalization: true });
    } catch {}
  }

  function releaseTerminalLease(attempt, lease, {
    expectedLeaseActor = synthesis.SYNTHESIS_AGENT_NAME ?? "self-evolve-synthesizer",
  } = {}) {
    if (!lease) return { ok: true };
    let identity;
    try { identity = leaseCleanupIdentity(attempt, lease); } catch { identity = null; }
    if (!identity || !identity.bindingMatches) {
      const warning = warnLeaseCleanup(attempt, lease, "synthesis-lease-binding-mismatch", expectedLeaseActor);
      return { ok: false, reason: "synthesis-lease-binding-mismatch", cleanupWarningPersisted: warning.ok === true };
    }
    const release = () => {
      try {
        return synthesis.releaseSynthesisLease?.(store, lease)
          ?? store.releaseLease?.(lease.key, lease.nonce)
          ?? { ok: false, reason: "synthesis-lease-unavailable" };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) };
      }
    };
    let released = release();
    if (released?.ok) {
      pendingSynthesisLeaseCleanups.delete(identity.cleanupKey);
      resolveLeaseCleanup(attempt, identity, "released");
      return released;
    }
    if (["lease-not-found", "nonce-mismatch"].includes(released?.reason)) {
      pendingSynthesisLeaseCleanups.delete(identity.cleanupKey);
      resolveLeaseCleanup(attempt, identity, released.reason === "nonce-mismatch"
        ? "lease-generation-replaced"
        : "lease-absent");
      return { ok: true, cleanupResolved: true, reason: released.reason };
    }
    pendingSynthesisLeaseCleanups.set(identity.cleanupKey, { attempt, lease, expectedLeaseActor });
    let warning = warnLeaseCleanup(attempt, lease, released?.reason, expectedLeaseActor);
    if (!warning.ok) {
      released = release();
      if (released?.ok || ["lease-not-found", "nonce-mismatch"].includes(released?.reason)) {
        pendingSynthesisLeaseCleanups.delete(identity.cleanupKey);
        return { ok: true, cleanupResolved: true, reason: released?.reason ?? "released-after-warning-failure" };
      }
      warning = warnLeaseCleanup(attempt, lease, released?.reason, expectedLeaseActor);
    }
    return { ...released, cleanupWarningPersisted: warning.ok === true };
  }

  function retryTerminalLeaseCleanups() {
    for (const { attempt, lease, expectedLeaseActor } of [...pendingSynthesisLeaseCleanups.values()]) {
      try { releaseTerminalLease(attempt, lease, { expectedLeaseActor }); } catch {}
    }
    let records;
    try { records = store.readRecords("audit-event"); } catch { return; }
    const resolved = new Set(records
      .filter((record) => record.payload?.details?.action === "synthesis-lease-cleanup-resolved")
      .map((record) => `${record.payload.details.outcomeId}:${record.payload.details.leaseNonceHash}`));
    let attempts;
    try {
      attempts = new Map(store.readRecords("synthesis-attempt")
        .map((item) => [item.payload.outcomeId, item.payload]));
    } catch { return; }
    for (const record of records) {
      const details = record.payload?.details;
      if (details?.action !== "synthesis-lease-cleanup-warning" || details.retryable !== true) continue;
      const cleanupKey = `${details.outcomeId}:${details.leaseNonceHash}`;
      if (resolved.has(cleanupKey) || pendingSynthesisLeaseCleanups.has(cleanupKey)) continue;
      const attempt = attempts.get(details.outcomeId);
      if (!attempt) continue;
      let expectedKey;
      try { expectedKey = synthesis.synthesisLeaseKey?.(attempt); } catch { continue; }
      if (!expectedKey || details.leaseKey !== expectedKey || typeof details.leaseNonceHash !== "string") continue;
      let status;
      try { status = store.getLeaseStatus?.(details.leaseKey); } catch { continue; }
      const identity = { leaseKey: details.leaseKey, leaseNonceHash: details.leaseNonceHash, cleanupKey };
      if (!status?.lease) {
        resolveLeaseCleanup(attempt, identity, "lease-absent");
        continue;
      }
      if (observation.hashSignature(status.lease.nonce) !== details.leaseNonceHash) {
        resolveLeaseCleanup(attempt, identity, "lease-generation-replaced");
        continue;
      }
      if (status.lease.actor !== details.expectedLeaseActor) continue;
      if (status.held && status.lease.pid !== process.pid) continue;
      releaseTerminalLease(attempt, { key: details.leaseKey, nonce: status.lease.nonce }, {
        expectedLeaseActor: details.expectedLeaseActor,
      });
    }
  }

  function synthesisOutcomeFor(attempt) {
    if (!attempt) return null;
    return store.readRecords("audit-event")
      .map((record) => schemas.parseSynthesisOutcomeAuditEvent(record.payload))
      .find((outcome) => outcome?.outcomeId === attempt.outcomeId) ?? null;
  }

  function persistSynthesisOutcome(synthesized, status, reason, faultInjection) {
    const attempt = synthesized?.attempt ?? synthesized;
    if (!attempt) return null;
    const terminalAt = now();
    const event = schemas.makeSynthesisOutcomeAuditEvent({
      outcomeId: attempt.outcomeId,
      projectFingerprint: attempt.projectFingerprint,
      clusterId: attempt.clusterId,
      status,
      success: status === "accepted" || status === "no-change",
      terminalAt,
      reasonCode: outcomeReason(status, reason),
    });
    const existing = synthesisOutcomeFor(attempt);
    if (existing) {
      const same = ["outcomeId", "projectFingerprint", "clusterId", "status", "success", "reasonCode"]
        .every((key) => existing[key] === event.details[key]);
      if (!same) throw new Error("synthesis-outcome-conflict");
      return existing;
    }
    const envelope = schemas.wrapRecord("audit-event", event, terminalAt);
    const appendOutcome = () => typeof store.appendSynthesisFinalizationAudit === "function"
      ? store.appendSynthesisFinalizationAudit(envelope)
      : store.appendRecord(envelope);
    let saved = appendOutcome();
    if (!saved?.ok) saved = appendOutcome();
    if (!saved?.ok) throw new Error(saved?.reason ?? "synthesis-outcome-write-failed");
    const persisted = schemas.parseSynthesisOutcomeAuditEvent(saved.record?.payload);
    const same = persisted && ["outcomeId", "projectFingerprint", "clusterId", "status", "success", "reasonCode"]
      .every((key) => persisted[key] === event.details[key]);
    if (!same) throw new Error("synthesis-outcome-conflict");
    faultInjection?.("pipeline-after-outcome-append", { attempt, event });
    return persisted;
  }

  function inventoryFor(options) {
    if (options.globalSkillCatalog?.ok && Array.isArray(options.globalSkillCatalog.records)) {
      globalCatalogs.set(options.globalSkillCatalog.records, options.globalSkillCatalog);
      return options.globalSkillCatalog.records;
    }
    // Integration always supplies the host discovery result, including a
    // failed result. Do not silently fall back to the retired persisted root
    // policy when the authoritative host projection is unavailable.
    if (Object.prototype.hasOwnProperty.call(options, "globalSkillCatalog")) {
      const records = [];
      globalCatalogs.set(records, options.globalSkillCatalog ?? {
        ok: false,
        policy: null,
        blockers: [{ code: "host-global-skill-catalog-unavailable" }],
      });
      return records;
    }
    if (Array.isArray(options.inventoryRecords)) {
      const policy = options.globalRootPolicy ?? store.getAutomationState?.().global?.globalRootPolicy
        ?? store.getSettings?.().global.globalRootPolicy ?? null;
      const catalog = inventory.buildGlobalSkillCatalog?.(policy, { projectRoot: options.projectRoot }) ?? null;
      if (catalog?.ok) globalCatalogs.set(options.inventoryRecords, { ...catalog, records: options.inventoryRecords });
      return options.inventoryRecords;
    }
    const policy = options.globalRootPolicy ?? store.getSettings?.().global.globalRootPolicy ?? null;
    const catalog = inventory.buildGlobalSkillCatalog?.(policy, { projectRoot: options.projectRoot }) ?? {
      ok: false,
      records: [],
      blockers: [{ code: "global-skill-catalog-unavailable" }],
    };
    const records = catalog.ok ? catalog.records : [];
    globalCatalogs.set(records, catalog);
    return records;
  }

  function materializeGlobalCandidates(clusters, options) {
    if (typeof store.materializeGlobalCandidates !== "function" || clusters.length === 0) return null;
    const records = inventoryFor(options);
    const catalog = globalCatalogs.get(records);
    if (!catalog?.ok || !catalog.policy) return null;
    const bindings = new Map();
    for (const cluster of clusters) {
      const targetLogicalName = cluster.targetLogicalName ?? null;
      const resolution = inventory.resolveGlobalSkillCandidate?.(targetLogicalName, catalog);
      if (resolution?.ok && resolution.binding) bindings.set(resolution.binding.bindingHash, resolution.binding);
    }
    if (bindings.size === 0) return null;
    const result = store.materializeGlobalCandidates({
      targetBindings: [...bindings.values()],
      rootPolicy: catalog.policy,
      nowMs: now(),
      automationStamp: options.automationStamp,
    });
    if (!result?.ok) throw new Error(`global-candidate-materialization-failed:${result?.reason ?? "unknown"}`);
    return { ...result, catalog };
  }

  function readEligibleGlobalCandidates(automationGeneration = null) {
    if (typeof store.readGlobalCandidates !== "function") return [];
    try {
      return store.readGlobalCandidates()
        .filter((candidate) => candidate?.state === "eligible"
          && (automationGeneration === null || candidate.automationGeneration === automationGeneration))
        .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    } catch {
      return [];
    }
  }

  function nextEligibleGlobalCandidate(materialization) {
    const fromMaterialization = materialization?.candidates
      ?.filter((candidate) => candidate?.state === "eligible")
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId))[0] ?? null;
    if (fromMaterialization) return { candidate: fromMaterialization, catalog: materialization.catalog ?? null };
    return null;
  }

  function isBudgetExhaustedReason(reason) {
    const value = String(reason ?? "").toLowerCase();
    return value.includes("passive-provider-budget")
      || value.includes("synthesis-budget")
      || value.includes("daily-synthesis")
      || value.includes("quota");
  }

  async function runOneGlobalCandidate({ ctx, candidate, catalog, options, timestamp, sessionIDHash }) {
    assertWorkActive(options.signal);
    const result = await synthesis.runGlobalSynthesis({
      ctx,
      candidate,
      catalog: catalog ?? undefined,
      inventoryModule: inventory,
      options: {
        store,
        ...(options.synthesis ?? {}),
        signal: options.signal,
        reservePassiveProviderCalls: typeof options.reservePassiveProviderCalls === "function"
          ? (count, context) => options.reservePassiveProviderCalls(count, {
              ...context,
              automationStamp: options.automationStamp,
            })
          : undefined,
        automationStamp: options.automationStamp,
        faultInjection: options.faultInjection,
        suppressors: options.globalSynthesisSuppressors ?? {
          bootValidated: true,
          hostSupported: true,
          circuitBreakerOpen: applier.circuitBreakerOpen?.() === true,
          processExcluded: false,
        },
        getSuppressors: options.getGlobalSynthesisSuppressors,
      },
      now,
    });
    return result;
  }

  function buildDrainSummary({ drained, headline, observations, capsules, capsuleSupport, eligibility, auditEvents, cycleReason }) {
    if (headline?.kind === "recommendation-ready") {
      return {
        result: "recommendation-ready",
        cycleOutcome: "recommendation-created",
        recommendation: headline.recommendation,
        drained,
        observations,
        capsules,
        capsuleSupport,
        eligibility,
        auditEvents,
        responseText: `Self-evolve created global recommendation ${headline.recommendation.recommendationId} for explicit review. No files were applied.`,
      };
    }
    if (headline?.kind === "no-change") {
      return {
        result: "no-eligible",
        cycleOutcome: "valid-no-change",
        cycleReason: cycleReason ?? "valid-no-change",
        drained,
        observations,
        capsules,
        capsuleSupport,
        eligibility,
        auditEvents,
        responseText: "Self-evolve completed bounded global synthesis without a safe change. No files were applied.",
      };
    }
    const allBudgetExhausted = drained.length > 0 && drained.every((item) => !item.result?.ok && isBudgetExhaustedReason(item.result?.reason));
    if (allBudgetExhausted) {
      return {
        result: "deferred",
        cycleOutcome: "deferred",
        cycleReason: "budget-deferred",
        drained,
        observations,
        capsules,
        capsuleSupport,
        eligibility,
        auditEvents,
        responseText: "Self-evolve deferred remaining eligible candidates because the configured synthesis budget was exhausted. Pending candidates retain durable continuations for a later drain pass.",
      };
    }
    if (drained.length > 0) {
      const failedReasons = drained
        .map((item) => item.result?.reason)
        .filter((reason) => !isBudgetExhaustedReason(reason))
        .slice(0, 1);
      const reason = failedReasons[0] ?? drained[0].result?.reason ?? "global-synthesis-failed";
      return {
        result: "failed-closed",
        cycleOutcome: "failed-closed",
        cycleReason: "drain-failure",
        reason,
        drained,
        observations,
        capsules,
        capsuleSupport,
        eligibility,
        auditEvents,
        responseText: `Self-evolve global synthesis failed closed: ${reason}. No files were applied.`,
      };
    }
    return null;
  }

  async function drainEligibleGlobalCandidates({
    ctx, options, auditStart, sessionIDHash, mode,
    observations = [], capsules = [], capsuleSupport = [], eligibility = [],
    seededMaterialization = null,
  }) {
    if (typeof synthesis.runGlobalSynthesis !== "function") return null;
    if (options.signal?.aborted) return null;
    if (applier.circuitBreakerOpen?.()) {
      appendDiagnosticAudit("pipeline-drain-breaker-open", "drain", { drainedCount: 0 }, options.automationStamp);
      return null;
    }
    const maxPerPass = Math.max(1, Number.isSafeInteger(options.maxCandidatesPerPass)
      ? options.maxCandidatesPerPass : DEFAULT_DRAIN_MAX_PER_PASS);
    const drainBudget = options.drainBudget ?? {};
    let synthesesRemaining = Math.min(
      maxPerPass,
      Number.isSafeInteger(drainBudget.synthesesRemaining) ? drainBudget.synthesesRemaining : maxPerPass,
    );
    const minPassivePerSynthesis = Number.isSafeInteger(drainBudget.minPassivePerSynthesis)
      ? Math.max(0, drainBudget.minPassivePerSynthesis)
      : DEFAULT_DRAIN_MIN_PASSIVE_PER_SYNTHESIS;
    let passiveCallsRemaining = Number.isSafeInteger(drainBudget.passiveCallsRemaining)
      ? drainBudget.passiveCallsRemaining : Infinity;
    const eligibleSeen = new Set();
    const drained = [];
    let headline = null;
    let budgetDeferred = false;
    let lease = null;
    try {
      // Acquire a cross-process drain lease so two processes do not run
      // competing drains against the same global candidate store. This is
      // best-effort: if the store lacks lease support, the drain still runs
      // because per-candidate synthesis leases enforce exact-once safety.
      if (typeof store.acquireLease === "function") {
        try {
          lease = store.acquireLease(DRAIN_LEASE_KEY, {
            ttlMs: DRAIN_LEASE_TTL_MS,
            actor: "self-evolve-pipeline-drain",
            automationStamp: options.automationStamp,
          });
        } catch { lease = null; }
        if (lease && !lease.ok) {
          appendDiagnosticAudit("pipeline-drain-lease-busy", "drain", { reason: String(lease.reason ?? "lease-busy") }, options.automationStamp);
          return null;
        }
      }
      while (synthesesRemaining > 0 && passiveCallsRemaining >= minPassivePerSynthesis) {
        assertWorkActive(options.signal);
        if (applier.circuitBreakerOpen?.()) {
          appendDiagnosticAudit("pipeline-drain-breaker-open", "drain", { drainedCount: drained.length }, options.automationStamp);
          break;
        }
        // H7-001 fairness: stable order by candidateId. After each synthesis,
        // the processed candidate transitions out of "eligible" (to
        // "recommended", "no-change", or "failed-closed"), so the next
        // iteration picks the next eligible candidate. Re-reading from the
        // store avoids stale state across the synthesis mutation.
        let candidateEntry = seededMaterialization && drained.length === 0
          ? nextEligibleGlobalCandidate(seededMaterialization)
          : null;
        if (!candidateEntry) {
          const freshEligible = readEligibleGlobalCandidates(options.automationStamp?.generation ?? null);
          const next = freshEligible.find((item) => !eligibleSeen.has(item.candidateId));
          if (!next) break;
          candidateEntry = { candidate: next, catalog: seededMaterialization?.catalog ?? null };
        }
        const { candidate, catalog } = candidateEntry;
        if (eligibleSeen.has(candidate.candidateId)) break;
        eligibleSeen.add(candidate.candidateId);

        options.faultInjection?.("pipeline-drain-before-synthesis", { sessionIDHash, candidate, drainedCount: drained.length });
        options.faultInjection?.("pipeline-boundary-synthesis", { sessionIDHash, globalCandidate: candidate });
        assertWorkActive(options.signal);

        const globalResult = await runOneGlobalCandidate({ ctx, candidate, catalog, options, timestamp: now(), sessionIDHash });
        options.faultInjection?.("pipeline-boundary-publication", { sessionIDHash, globalResult });
        assertWorkActive(options.signal);

        synthesesRemaining -= 1;
        drained.push({ candidateId: candidate.candidateId, result: globalResult });

        if (globalResult?.ok && globalResult.recommendation && !headline) {
          headline = { kind: "recommendation-ready", recommendation: globalResult.recommendation };
        } else if (globalResult?.ok && globalResult.noChange && !headline) {
          headline = { kind: "no-change" };
        }

        // H7-001 bounded: stop immediately when the configured budget is
        // exhausted. Pending eligible candidates retain durable
        // continuations (the candidate record itself) for a later pass.
        if (!globalResult?.ok && isBudgetExhaustedReason(globalResult?.reason)) {
          budgetDeferred = true;
          appendDiagnosticAudit("pipeline-drain-budget-deferred", "drain", {
            candidateId: candidate.candidateId,
            reason: String(globalResult.reason).slice(0, 160),
            drainedCount: drained.length,
            synthesesRemaining,
          }, options.automationStamp);
          break;
        }
      }
    } finally {
      if (lease?.ok && typeof store.releaseLease === "function") {
        try { store.releaseLease(DRAIN_LEASE_KEY, lease.nonce); } catch {}
      }
    }

    const auditEvents = auditSince(store, auditStart);
    const summary = buildDrainSummary({
      drained, headline, observations, capsules, capsuleSupport, eligibility, auditEvents,
      cycleReason: budgetDeferred ? "budget-deferred" : undefined,
    });
    if (summary) {
      appendDiagnosticAudit("pipeline-drain-settled", "drain", {
        drainedCount: drained.length,
        result: summary.result,
        budgetDeferred,
        ...(headline?.recommendation ? { recommendationId: headline.recommendation.recommendationId } : {}),
      }, options.automationStamp);
      return summary;
    }
    // No candidates were drained (empty queue) and no headline: signal the
    // caller that no drain happened so it can return the global-only
    // not-eligible result.
    appendDiagnosticAudit("pipeline-drain-empty", "drain", { drainedCount: 0 }, options.automationStamp);
    return null;
  }

  function readProposalContent(proposal) {
    if (typeof proposal.proposedContent === "string") return proposal.proposedContent;
    const all = store.readRecords("proposal-content").map((record) => record.payload).filter((chunk) => chunk.proposalId === proposal.id);
    if (!all.length || all.some((chunk) => chunk.contentHash !== proposal.proposedContentHash)) return null;
    const chunks = all.sort((left, right) => left.chunkIndex - right.chunkIndex);
    if (chunks.length !== chunks[0].chunkCount) return null;
    if (chunks.some((chunk, index) => chunk.chunkIndex !== index || chunk.chunkCount !== chunks.length || chunk.contentEncoding !== "base64")) return null;
    const encoded = chunks.map((chunk) => chunk.content).join("");
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) return null;
    const content = decoded.toString("utf8");
    return inventory.hashSkillContent?.(content) === proposal.proposedContentHash ? content : null;
  }

  function failProposalClosed(proposal, reason, timestamp = now()) {
    const current = currentProposal(store, proposal.id);
    if (!current || current.state === "failed-closed") return current;
    if (!["critic-pending", "pending", "approved", "applied"].includes(current.state)) return current;
    const decision = schemas.makeDecision({
      proposalId: current.id,
      targetHash: current.skillTarget.currentHash,
      proposedContentHash: current.proposedContentHash,
      decisionVersion: current.decisionVersion + 1,
      actor: "self-evolve-pipeline",
      timestamp,
      nonce: observation.hashSignature(`synthesis-recovery:${current.id}:${current.decisionVersion + 1}:${reason}`),
      priorState: current.state,
      newState: "failed-closed",
    });
    const committed = store.commitDecision(decision);
    if (!committed?.ok) throw new Error(committed?.reason ?? "proposal-failed-closed-write-failed");
    return committed.proposal;
  }

  function recoverSynthesisAttempts() {
    retryTerminalLeaseCleanups();
    const globalRecovery = store.recoverGlobalSynthesisAttempts?.() ?? { ok: true, recovered: [] };
    if (!globalRecovery.ok) throw new Error(globalRecovery.reason ?? "global-synthesis-recovery-failed");
    const recoveredGlobal = globalRecovery.recovered.map((item) => ({
      ok: true,
      global: true,
      attemptId: item.attemptId,
      status: item.deferred ? "deferred" : item.state,
      ...(item.deferred ? { deferred: true } : {}),
    }));
    const outcomes = new Map();
    for (const record of store.readRecords("audit-event")) {
      const outcome = schemas.parseSynthesisOutcomeAuditEvent(record.payload);
      if (outcome) outcomes.set(outcome.outcomeId, outcome);
    }
    const recovered = [];
    const attempts = new Map();
    for (const record of store.readRecords("synthesis-attempt")) {
      const prior = attempts.get(record.payload.outcomeId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(record.payload)) throw new Error("synthesis-attempt-conflict");
      attempts.set(record.payload.outcomeId, record.payload);
    }
    for (const attempt of attempts.values()) {
      const key = synthesis.synthesisLeaseKey?.(attempt)
        ?? `synthesis_${observation.hashSignature(`synthesis-lease-v1\n${attempt.projectFingerprint}\n${attempt.clusterId}\n${attempt.targetHash}`)}`;
      const acquired = store.acquireLease?.(key, { ttlMs: 5 * 60 * 1000, actor: "self-evolve-synthesis-recovery" });
      if (!acquired?.ok) {
        recovered.push(acquired?.reason === "lease-busy"
          ? { ok: true, deferred: true, outcomeId: attempt.outcomeId, proposalId: attempt.proposalId, status: "deferred", reason: "lease-busy" }
          : { ok: false, outcomeId: attempt.outcomeId, proposalId: attempt.proposalId, status: "failed", reason: acquired?.reason ?? "lease-error" });
        continue;
      }
      try {
        const outcome = outcomes.get(attempt.outcomeId);
        const proposal = currentProposal(store, attempt.proposalId);
        if (outcome) {
          if (outcome.projectFingerprint !== attempt.projectFingerprint || outcome.clusterId !== attempt.clusterId) throw new Error("synthesis-outcome-binding-mismatch");
          if (!outcome.success && proposal && ["critic-pending", "pending", "approved", "applied"].includes(proposal.state)) {
            failProposalClosed(proposal, "incomplete-synthesis-attempt");
          }
          continue;
        }
        const content = proposal ? readProposalContent(proposal) : null;
        if (proposal?.criticPassed === true && proposal.validDeterministic === true && !proposal.injectionFlagged
          && ["pending", "approved", "applied"].includes(proposal.state) && content !== null) {
          persistSynthesisOutcome(attempt, "accepted", "accepted");
          recovered.push({ ok: true, outcomeId: attempt.outcomeId, proposalId: proposal.id, status: "accepted" });
          continue;
        }
        if (proposal && ["critic-pending", "pending", "approved", "applied"].includes(proposal.state)) failProposalClosed(proposal, "incomplete-synthesis-attempt");
        const reason = proposal && content === null ? "proposal-content-unavailable" : "critic-failed";
        persistSynthesisOutcome(attempt, "failed", reason);
        recovered.push({ ok: true, outcomeId: attempt.outcomeId, proposalId: attempt.proposalId, status: "failed" });
      } finally {
        releaseTerminalLease(attempt, { key, nonce: acquired.nonce }, {
          expectedLeaseActor: "self-evolve-synthesis-recovery",
        });
      }
    }
    return [...recoveredGlobal, ...recovered];
  }

  function recoverContributionTransactions() {
    return store.recoverContributionTransactions?.() ?? { ok: true, recovered: 0, failed: 0, outcomes: [] };
  }

  async function runEvolutionCycle({ ctx, sessionID, projectFingerprint, scopeFingerprint, trigger, mode, rootSessionID, rootSessionIDHash, originKind, options = {} }) {
    const automation = store.getAutomationState?.();
    if (!automation?.ok || !automation.enabled) {
      return {
        result: "automatic-disabled",
        cycleOutcome: "automatic-disabled",
        cycleReason: automation?.reason ?? "automatic-recommendations-disabled",
        observations: [],
        capsules: [],
        capsuleSupport: [],
        eligibility: [],
        auditEvents: [],
        responseText: "Self-evolve Automatic recommendations are Off. No session data was read and no autonomous work was performed.",
      };
    }
    if (options.automationStamp && !store.compareAutomationStamp?.(options.automationStamp)) {
      return {
        result: "failed-closed",
        cycleOutcome: "failed-closed",
        cycleReason: "stale-automation-generation",
        observations: [], capsules: [], capsuleSupport: [], eligibility: [], auditEvents: [],
        responseText: "Self-evolve rejected stale automatic work. No files were applied.",
      };
    }
    const automationStamp = options.automationStamp ?? automation.stamp;
    options = { ...options, automationStamp };
    const auditStart = store.readRecords("audit-event").length;
    const observations = [];
    const capsules = [];
    const capsuleSupport = [];
    let eligibility = [];
    try {
      assertWorkActive(options.signal);
      const sessionIDHash = observation.hashSessionLineage(sessionID);
      const lineage = episodeLineage({ sessionID, projectFingerprint, rootSessionID, rootSessionIDHash, originKind, trigger, options, schemas, observation });
      const cursorRecord = latestCursor(store, sessionIDHash);
      const cursor = cursorRecord?.payload ?? schemas.makeEpisodeCursor({ sessionIDHash });
      const limit = Math.min(256, Number.isSafeInteger(options.messageLimit) && options.messageLimit > 0 ? options.messageLimit : DEFAULT_MESSAGE_LIMIT);
      const messages = await readSessionMessages(ctx, sessionID, limit, {
        timeoutMs: options.sdkTimeoutMs ?? 15_000,
        signal: options.signal,
        label: "Self-evolve durable session.messages",
      });
      options.faultInjection?.("pipeline-boundary-message-read", { sessionIDHash, messages });
      assertWorkActive(options.signal);
      const messageHashes = messages.map((message) => observation.hashMessageCursor(message));
      const lastObservedMessageHash = messageHashes.at(-1) ?? null;
      if ((cursor.automationGeneration ?? 1) !== automationStamp.generation) {
        const timestamp = now();
        const baseline = schemas.makeEpisodeCursor({
          sessionIDHash,
          lastIdleAt: timestamp,
          lastObservedMessageHash,
          leaseNonce: null,
          automationGeneration: automationStamp.generation,
        });
        if (cursorRecord) {
          const updated = store.runCas(
            "episode-cursor",
            cursor.sessionIDHash,
            cursor.lastObservedMessageHash,
            () => baseline,
            (payload) => payload?.lastObservedMessageHash,
            { automationStamp },
          );
          if (!updated?.ok) throw new Error(updated?.reason ?? "cursor-baseline-cas-failed");
        } else {
          append("episode-cursor", baseline, timestamp, automationStamp);
        }
        return {
          result: "automatic-baselined",
          cycleOutcome: "automatic-baselined",
          cycleReason: "future-evidence-only",
          observations, capsules, capsuleSupport, eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: "Self-evolve established a future-only Automatic baseline. Existing session history was not converted into evidence.",
        };
      }
      if (cursorRecord && messages.length === 0) {
        appendAudit("message-window-empty", sessionIDHash, { sessionIDHash, preservedMessageHash: cursor.lastObservedMessageHash }, { automationStamp });
        return {
          result: "no-eligible",
          cycleOutcome: "no-observations",
          cycleReason: "empty-window",
          observations,
          capsules,
          capsuleSupport,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: "Self-evolve received an empty message window and preserved the prior cursor without creating evidence. No files were applied.",
        };
      }
      if (cursorRecord && cursor.lastObservedMessageHash === lastObservedMessageHash) {
        const proposal = pendingProposal(store, projectFingerprint);
        // H7-001: An unchanged cursor must not block draining eligible global
        // candidates that retain durable continuations from a prior observation.
        // The drain is bounded, budget-aware, and respects pause/kill/breaker.
        if (typeof synthesis.runGlobalSynthesis === "function") {
          const drainResult = await drainEligibleGlobalCandidates({
            ctx, options, auditStart, sessionIDHash, mode,
            observations, capsules, capsuleSupport, eligibility,
            seededMaterialization: null,
          });
          if (drainResult) {
            const proposalSuffix = proposal ? ` ${proposalText(proposal)}` : "";
            if (drainResult.result === "recommendation-ready") {
              return drainResult;
            }
            if (drainResult.drained?.length > 0) {
              return {
                ...drainResult,
                responseText: `${drainResult.responseText}${proposalSuffix}`,
              };
            }
          }
        }
        return {
          result: proposal ? "proposal-pending" : "no-eligible",
          cycleOutcome: "cursor-unchanged",
          cycleReason: "already-processed",
          ...(proposal ? { proposal } : {}),
          observations,
          capsules,
          capsuleSupport,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: proposal
            ? `${proposalText(proposal)}\nThis cursor was already processed; no duplicate observations or synthesis were created.`
            : "Self-evolve skipped this scan because this session message cursor was already processed. No files were applied.",
        };
      }

      const priorIndex = cursor.lastObservedMessageHash === null ? -1 : messageHashes.lastIndexOf(cursor.lastObservedMessageHash);
      const timestamp = now();
      const nextCursor = schemas.makeEpisodeCursor({
        sessionIDHash,
        lastIdleAt: timestamp,
        lastObservedMessageHash,
        leaseNonce: null,
        automationGeneration: automationStamp.generation,
      });
      const advanceCursor = () => {
        if (cursorRecord) {
          const updated = store.runCas(
            "episode-cursor",
            cursor.sessionIDHash,
            cursor.lastObservedMessageHash,
            () => nextCursor,
            (payload) => payload?.lastObservedMessageHash,
            { automationStamp },
          );
          if (!updated?.ok) throw new Error(updated?.reason ?? "cursor-cas-failed");
        } else {
          append("episode-cursor", nextCursor, timestamp, automationStamp);
        }
      };
      if (cursor.lastObservedMessageHash !== null && priorIndex < 0) {
        advanceCursor();
        appendAudit("message-cursor-gap", sessionIDHash, { sessionIDHash, priorMessageHash: cursor.lastObservedMessageHash, lastObservedMessageHash }, { automationStamp });
        return {
          result: "no-eligible",
          cycleOutcome: "no-observations",
          cycleReason: "cursor-gap",
          observations,
          capsules,
          capsuleSupport,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: "Self-evolve advanced past a bounded message-cursor gap without creating evidence from an unknown overlap. No files were applied.",
        };
      }

      const unseenMessages = messages.slice(priorIndex + 1);
      const episode = {
        projectFingerprint,
        scopeFingerprint,
        startedAt: timestamp,
        endedAt: timestamp,
        messages: metadataMessages(unseenMessages, privacy, automationStamp),
      };
      const receipts = observation.extractReceipts(episode, { projectFingerprint, scopeFingerprint, now: timestamp });
      options.faultInjection?.("pipeline-boundary-observation-write", { sessionIDHash, receipts });
      assertWorkActive(options.signal);
      const injectionFlagged = episode.messages.some((message) => message.injectionFlagged === true);
      for (const receipt of receipts) {
        append("receipt", receipt, timestamp, automationStamp);
        const incidentId = observation.hashSignature(`self-evolve-incident-v2\n${automationStamp.generation}\n${sessionIDHash}\n${cursor.lastObservedMessageHash ?? "start"}\n${lastObservedMessageHash ?? "empty"}\n${receipt.signatureHash}`);
        const candidate = schemas.makeObservation({
          id: observation.hashSignature(JSON.stringify({ incidentId, receipt: receipt.signatureHash })),
          projectFingerprint,
          receiptIds: [receipt.signatureHash],
          structuredFields: receiptFields(receipt),
          incidentId,
          sessionLineageHash: sessionIDHash,
          rootLineageHash: lineage.rootLineageHash,
          originKind: lineage.originKind,
          createdAt: timestamp,
          injectionFlagged,
          redacted: true,
          automationGeneration: automationStamp.generation,
        });
        const scrubbed = privacy.scrubObservation(candidate, { automationStamp });
        if (!scrubbed?.ok) throw new Error(`observation-rejected:${scrubbed?.reason ?? "unknown"}`);
        append("observation", scrubbed.sanitized ?? scrubbed.observation ?? scrubbed, timestamp, automationStamp);
        observations.push(scrubbed.sanitized ?? scrubbed.observation ?? scrubbed);
        if (injectionFlagged) {
          capsuleSupport.push({ incidentId, available: false, reason: "injection-flagged" });
        } else {
          const derived = observation.deriveEvidenceCapsuleSummary?.(episode, receipt)
            ?? { ok: false, reason: "capsule-derivation-unavailable" };
          const admitted = derived.ok && typeof privacy.createEvidenceCapsule === "function"
            ? privacy.createEvidenceCapsule({
                incidentId,
                receiptType: receipt.receiptType,
                targetLogicalName: receipt.targetLogicalName,
                summary: derived.summary,
              }, { automationStamp })
            : { ok: false, reason: derived.reason ?? "capsule-admission-unavailable" };
          if (admitted?.ok && admitted.capsule) {
            capsules.push(admitted.capsule);
            capsuleSupport.push({ incidentId, available: true, capsuleId: admitted.capsule.capsuleId });
          } else {
            capsuleSupport.push({ incidentId, available: false, reason: admitted?.reason ?? "evidence-capsule-unavailable" });
          }
        }
      }

      // H13-001: Cursor finality must FOLLOW durable admission of all
      // retry-required work derived from the current observation. The prior
      // implementation committed the cursor here (before clusters,
      // contributions, and candidate materialization), so a crash between the
      // cursor commit and downstream admission silently lost the work: the
      // cursor had already advanced, so the next scan returned "already
      // processed" and never re-observed the messages. The cursor is now
      // committed only after materializeGlobalCandidates succeeds. All
      // downstream writes are idempotent (deduped by record ID, incident ID,
      // or binding hash), so a crash before cursor commit converges on the
      // next scan with no duplicate observations, contributions, or
      // candidates.

      const allObservations = store.readRecords("observation").map((record) => record.payload)
        .filter((item) => item.projectFingerprint === projectFingerprint
          && item.automationGeneration === automationStamp.generation
          && privacy.isObservationEligible?.(item.id) !== false);
      const clusters = observation.correlateObservations(allObservations);
      eligibility = observation.evaluateEligibility(clusters, { now: timestamp, ...(options.eligibility ?? {}) });
      clusters.forEach((cluster) => append("evidence-cluster", cluster, timestamp, automationStamp));
      eligibility.forEach((item) => append("eligibility-explanation", item, timestamp, automationStamp));
      if (options.stopAfter === "correlate") {
        return {
          result: "observed-shadow",
          cycleOutcome: observations.length ? "observed-shadow" : "no-observations",
          observations,
          capsules,
          capsuleSupport,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: "Self-evolve recorded and correlated bounded project evidence in shadow mode. No global contribution, provider call, recommendation, or file application was attempted.",
        };
      }
      if (typeof privacy.publishContribution === "function") {
        options.faultInjection?.("pipeline-boundary-contribution", { sessionIDHash, clusters });
        assertWorkActive(options.signal);
        const evidenceDomain = schemas.makeEvidenceDomain(options.evidenceDomain
          ?? observation.deriveSourceLineage?.({ remoteUrl: options.remoteUrl, remoteUrls: options.sourceRemoteUrls })
          ?? { lineageStatus: "unknown", sourceLineageHash: null });
        for (const cluster of clusters) {
          for (const item of allObservations.filter((candidate) => cluster.incidentIds.includes(candidate.incidentId))) {
            const signatureHash = signatureForCluster(cluster, item, observation.hashSignature);
            if (!signatureHash || item.injectionFlagged) continue;
            const support = privacy.getEvidenceCapsuleSupport?.(item.incidentId, { automationStamp })
              ?? { available: false, reason: "evidence-capsule-unavailable" };
            if (!support.available) continue;
            const published = privacy.publishContribution({
              claimType: "global-skill-candidate",
              receiptType: cluster.receiptType,
              signatureHash,
              incidentId: item.incidentId,
              capsuleId: support.capsuleId,
              clusterId: cluster.id,
              evidenceDomainId: evidenceDomain.domainId,
              occurrenceCount: item.structuredFields.occurrences,
              firstSeenAt: item.createdAt,
              lastSeenAt: item.createdAt,
            }, { automationStamp });
            if (!published?.ok && ![
              "sanitized-excerpts-consent-required",
              "cross-repo-consent-required",
              "evidence-capsule-unavailable",
            ].includes(published?.reason)) {
              throw new Error(`contribution-rejected:${published?.reason ?? "unknown"}`);
            }
          }
        }
      }
      const globalMaterialization = materializeGlobalCandidates(clusters, options);
      // H13-001: All retry-required work derived from this observation has
      // been durably admitted (receipts, observations, capsules, clusters,
      // eligibility, contributions, global candidates + support sets). The
      // cursor may now commit safely. A crash after this point leaves the
      // cursor advanced; the candidate itself is the durable continuation and
      // will be drained on the next scan's cursor-unchanged pass or an
      // independent drainEligibleCandidates call.
      advanceCursor();
      options.faultInjection?.("pipeline-boundary-cursor-advanced", { sessionIDHash, lastObservedMessageHash });
      // H7-001: Drain ALL eligible global candidates in a bounded, fair,
      // budget-aware loop instead of processing only the first one. Each
      // candidate either completes (recommendation/no-change/failed-closed)
      // or retains a durable continuation that will be retried on the next
      // drain pass or restart.
      if (typeof synthesis.runGlobalSynthesis === "function") {
        const drainResult = await drainEligibleGlobalCandidates({
          ctx, options, auditStart, sessionIDHash, mode,
          observations, capsules, capsuleSupport, eligibility,
          seededMaterialization: globalMaterialization,
        });
        if (drainResult) return drainResult;
      }
      const globalCandidate = globalMaterialization?.candidates
        ?.filter((candidate) => candidate.state === "eligible")
        .sort((left, right) => left.candidateId.localeCompare(right.candidateId))[0] ?? null;
      return {
        result: "no-eligible",
        cycleOutcome: observations.length ? "not-eligible" : "no-observations",
        cycleReason: "insufficient-evidence",
        observations,
        capsules,
        capsuleSupport,
        eligibility,
        auditEvents: auditSince(store, auditStart),
        responseText: globalCandidate
          ? "Self-evolve found no eligible global recommendation for this evidence. No project proposal was created and no files were applied."
          : noEligibleText(eligibility),
      };
    } catch (error) {
      try { appendAudit("pipeline-failure", observation.hashSessionLineage(sessionID), { reason: String(error?.message ?? error).slice(0, 400), trigger: String(trigger?.reason ?? trigger?.kind ?? trigger ?? "manual") }, { automationStamp }); } catch {}
      return {
        result: "failed-closed",
        cycleOutcome: "failed-closed",
        observations,
        capsules,
        capsuleSupport,
        eligibility,
        auditEvents: auditSince(store, auditStart),
        responseText: `Self-evolve failed closed: ${String(error?.message ?? error)}. No files were applied.`,
      };
    }
  }

  async function runApprovalFlow({ ctx, proposalId, actor, mode, projectFingerprint, headless = false }) {
    const auditStart = store.readRecords("audit-event").length;
    const proposal = currentProposal(store, proposalId);
    if (!proposal || proposal.projectFingerprint !== projectFingerprint) return { result: "failed-closed", auditEvents: [], responseText: `Proposal ${proposalId} was not found in this project.` };
    if (proposal.state !== "approved") return { result: "failed-closed", auditEvents: [], responseText: `Proposal ${proposalId} is ${proposal.state}; an exact approval decision is required before apply.` };
    const decision = store.readRecords("decision").map((record) => record.payload).findLast((item) =>
      item.proposalId === proposal.id
      && item.newState === "approved"
      && item.targetHash === proposal.skillTarget.currentHash
      && item.proposedContentHash === proposal.proposedContentHash
      && item.decisionVersion === proposal.decisionVersion);
    if (!decision) return { result: "failed-closed", auditEvents: [], responseText: `Proposal ${proposalId} has no matching one-use approval decision.` };
    const consumed = store.readRecords("audit-event").some((record) => record.payload.kind === "apply"
      && record.payload.proposalId === proposal.id
      && record.payload.details?.["readback-verified"] === true);
    if (consumed) return { result: "failed-closed", auditEvents: [], responseText: `Proposal ${proposalId} approval decision was already consumed.` };
    const content = readProposalContent(proposal);
    if (content === null) return { result: "failed-closed", auditEvents: [], responseText: `Proposal ${proposalId} content is unavailable or failed its hash check.` };
    const effectiveMode = mode ?? commands.getEffectiveMode?.({ projectFingerprint }) ?? "manual";
    const result = await applier.applyProposal({ ctx, proposal: { ...proposal, proposedContent: content }, decision, actor, mode: effectiveMode, headless });
    return result?.ok
      ? { result: "applied", auditEvents: auditSince(store, auditStart), responseText: `Applied proposal ${proposalId}; appliedHash ${result.appliedHash}; auditId ${result.auditId}.` }
      : { result: result?.deferred ? "deferred" : "failed-closed", deferred: result?.deferred === true, reason: result?.reason ?? "apply-failed", auditEvents: auditSince(store, auditStart), responseText: `Proposal ${proposalId} was not applied: ${result?.reason ?? "apply-failed"}.` };
  }

  async function runRollbackFlow({ ctx, proposalId, actor, reason }) {
    const auditStart = store.readRecords("audit-event").length;
    const result = await applier.rollbackApplied({ ctx, proposalId, actor, reason });
    return result?.ok
      ? { result: "rolled-back", auditEvents: auditSince(store, auditStart), responseText: `Rolled back proposal ${proposalId}; restored hash ${result.rolledBackHash}.` }
      : { result: "failed-closed", reason: result?.reason ?? "rollback-failed", auditEvents: auditSince(store, auditStart), responseText: `Rollback for proposal ${proposalId} failed closed: ${result?.reason ?? "rollback-failed"}.` };
  }

  async function runRecoveryOnStartup() {
    const outcomes = await applier.recoverPending();
    return {
      healthy: outcomes.every((item) => item.ok),
      recovered: outcomes.filter((item) => item.ok).length,
      failed: outcomes.filter((item) => !item.ok).length,
      outcomes,
    };
  }

  // H7-001: Independent candidate drain entry point. This is triggerable
  // without a new source observation: it reads eligible candidates directly
  // from the store and drains them in a bounded, fair, budget-aware loop.
  // A caller (integration, command, or scheduler) invokes this when it wants
  // to resume pending durable continuations outside the observe-to-notify
  // flow. Each candidate either completes or retains its durable
  // continuation for a later pass.
  async function drainEligibleCandidates({ ctx, projectFingerprint, scopeFingerprint, options = {} }) {
    const auditStart = store.readRecords("audit-event").length;
    const sessionIDHash = options.sessionIDHash ?? observation.hashSessionLineage(`drain:${projectFingerprint ?? "global"}`);
    return (await drainEligibleGlobalCandidates({
      ctx,
      options,
      auditStart,
      sessionIDHash,
      mode: options.mode ?? "auto",
      observations: [],
      capsules: [],
      capsuleSupport: [],
      eligibility: [],
      seededMaterialization: null,
    })) ?? {
      result: "no-eligible",
      cycleOutcome: "drain-empty",
      cycleReason: "no-eligible-candidates",
      observations: [],
      capsules: [],
      capsuleSupport: [],
      eligibility: [],
      auditEvents: auditSince(store, auditStart),
      responseText: "Self-evolve found no eligible global candidates to drain. No files were applied.",
    };
  }

  function close() {
    retryTerminalLeaseCleanups();
    const cleanup = [...pendingSynthesisLeaseCleanups.values()].map(({ attempt, lease }) => {
      let identity;
      try { identity = leaseCleanupIdentity(attempt, lease); } catch { identity = null; }
      const durable = identity
        ? hasLeaseCleanupEvent("synthesis-lease-cleanup-warning", attempt.outcomeId, identity.leaseNonceHash)
        : false;
      return { outcomeId: attempt.outcomeId, durable };
    });
    applier.close?.();
    const storeResult = store.close?.() ?? { ok: true };
    return {
      ok: storeResult?.ok !== false && cleanup.every((item) => item.durable),
      cleanup,
      store: storeResult,
    };
  }

  return Object.freeze({ runEvolutionCycle, runApprovalFlow, runRollbackFlow, runRecoveryOnStartup, recoverContributionTransactions, recoverSynthesisAttempts, readProposalContent, drainEligibleCandidates, close });
}
