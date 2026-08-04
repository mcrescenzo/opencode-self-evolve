import path from "node:path";
import { readSessionMessages } from "./self-evolve-client.js";
import { partIsExcludedFromEvidence } from "./self-evolve-observation.js";
import { latestByLogicalId } from "./self-evolve-schemas.js";

const DEFAULT_MESSAGE_LIMIT = 120;
const CONTENT_CHUNK_SIZE = 400;

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

function metadataMessages(messages, privacy) {
  return messages.flatMap((message) => {
    if (partIsExcludedFromEvidence(message)) return [];
    const parts = messageParts(message);
    const evidenceParts = parts?.filter((part) => !partIsExcludedFromEvidence(part)) ?? null;
    if (parts?.length && evidenceParts.length === 0) return [];
    const role = messageRole(message);
    const text = messageText(message, evidenceParts).trim();
    const command = role === "user" ? text.match(/^\s*(\/[A-Za-z0-9][A-Za-z0-9_-]*)\b/u)?.[1] : null;
    const excerpt = text && privacy?.scrubExcerpt ? privacy.scrubExcerpt({ text }) : null;
    const contentScan = text && privacy?.scanForForbiddenContent ? privacy.scanForForbiddenContent(text) : null;
    const base = {
      role,
      ...(command ? { commandName: command.toLowerCase() } : {}),
      ...(excerpt?.ok ? { content: excerpt.redacted } : {}),
      injectionFlagged: contentScan?.issues?.some((issue) => issue === "prompt-injection-marker" || issue === "authority-escalation") === true,
      isSelfEvolveOutput: selfEvolveOutput(message),
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
  };
  if (receipt.receiptType === "repeated-command") structuredFields.commandSignatureHash = receipt.signatureHash;
  if (receipt.receiptType === "repeated-tool-error") structuredFields.toolErrorCode = receipt.signatureHash.slice(0, 128);
  if (receipt.receiptType === "repeated-manual-procedure") structuredFields.procedureFingerprint = receipt.signatureHash;
  if (receipt.receiptType === "repeated-clarification") structuredFields.clarificationCategory = "repeated-user-clarification";
  return structuredFields;
}

function proposalText(proposal, mode) {
  const readiness = mode === "manual" ? "pending manual review" : "ready for explicit approval";
  return [
    `Self-evolve proposal ${proposal.id} is ${readiness}.`,
    `Target: ${proposal.skillTarget.relativePath}`,
    `Rationale: ${proposal.rationaleText}`,
    `Review: /self-evolve review ${proposal.id}`,
    mode === "manual" ? "Manual mode is advisory and cannot approve or apply." : "Use /self-evolve inbox or review to obtain the current exact approval tuple.",
    "No files were applied by this scan.",
  ].join("\n");
}

function noEligibleText(eligibility) {
  const reasons = [...new Set(eligibility.flatMap((item) => item.reasons ?? []))];
  return `Self-evolve recorded bounded observations but no evidence cluster is eligible. ${reasons.length ? `Unmet gates: ${reasons.join(", ")}. ` : ""}No files were applied.`;
}

function episodeLineage({ sessionID, projectFingerprint, rootSessionID, rootSessionIDHash, originKind, options, schemas, observation }) {
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
  return observation.resolveRootLineage({
    sessionID,
    projectFingerprint,
    sessions: options.sessionAncestry ?? [{ sessionID, projectFingerprint }],
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

  function append(kind, payload, timestamp = now()) {
    const saved = store.appendRecord(schemas.wrapRecord(kind, payload, timestamp));
    if (!saved?.ok) throw new Error(saved?.reason ?? `${kind}-write-failed`);
    return saved;
  }

  function appendAudit(action, subjectId, details = {}) {
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
    append("audit-event", event, timestamp);
    return event;
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
    const existing = store.readRecords("audit-event")
      .map((record) => schemas.parseSynthesisOutcomeAuditEvent(record.payload))
      .find((outcome) => outcome?.outcomeId === attempt.outcomeId);
    if (existing) {
      const same = ["outcomeId", "projectFingerprint", "clusterId", "status", "success", "reasonCode"]
        .every((key) => existing[key] === event.details[key]);
      if (!same) throw new Error("synthesis-outcome-conflict");
      if (synthesized?.lease) synthesis.releaseSynthesisLease?.(store, synthesized.lease);
      return existing;
    }
    const saved = store.appendRecord(schemas.wrapRecord("audit-event", event, terminalAt));
    if (!saved?.ok) throw new Error(saved?.reason ?? "synthesis-outcome-write-failed");
    const persisted = schemas.parseSynthesisOutcomeAuditEvent(saved.record?.payload);
    const same = persisted && ["outcomeId", "projectFingerprint", "clusterId", "status", "success", "reasonCode"]
      .every((key) => persisted[key] === event.details[key]);
    if (!same) throw new Error("synthesis-outcome-conflict");
    faultInjection?.("pipeline-after-outcome-append", { attempt, event });
    if (synthesized?.lease) {
      const released = synthesis.releaseSynthesisLease?.(store, synthesized.lease);
      if (!released?.ok) throw new Error(released?.reason ?? "synthesis-lease-release-failed");
    }
    return saved.record.payload;
  }

  function inventoryFor(options) {
    if (Array.isArray(options.inventoryRecords)) return options.inventoryRecords;
    const projectRoot = options.projectRoot;
    const repoSkillRoots = options.repoSkillRoots ?? (typeof projectRoot === "string" && projectRoot
      ? [path.join(projectRoot, ".opencode", "skills")]
      : []);
    const roots = options.canonicalRoots ?? inventory.loadAllowlist?.({
      globalSkillRoots: options.globalSkillRoots ?? store.getSettings?.().global.allowedSkillRoots ?? [],
      repoSkillRoots,
      projectRoot,
    })?.canonicalRoots ?? [];
    return inventory.discoverSkills?.(roots) ?? [];
  }

  function targetFor(records, options) {
    if (options.targetSkill) return options.targetSkill;
    if (options.targetRelativePath) return records.find((item) => item.relativePath === options.targetRelativePath) ?? null;
    return records[0] ?? null;
  }

  function captureSynthesisContent(ctx, captured) {
    const prompt = ctx?.client?.session?.prompt;
    if (typeof prompt !== "function") return ctx;
    return {
      ...ctx,
      client: {
        ...ctx.client,
        session: {
          ...ctx.client.session,
          prompt: async (...args) => {
            const result = await prompt.call(ctx.client.session, ...args);
            const output = result?.data?.info?.structured_output ?? result?.data?.structured_output ?? result?.info?.structured_output ?? result?.structured_output;
            if (typeof output?.proposedContent === "string" && typeof output?.proposedContentHash === "string") {
              captured.set(output.proposedContentHash, output.proposedContent);
            }
            return result;
          },
        },
      },
    };
  }

  function persistProposalContent(proposal, content, faultInjection) {
    if (typeof content !== "string" || inventory.hashSkillContent?.(content) !== proposal.proposedContentHash) {
      throw new Error("proposal-content-unavailable");
    }
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const chunks = encoded.match(new RegExp(`.{1,${CONTENT_CHUNK_SIZE}}`, "gu")) ?? [""];
    chunks.forEach((chunk, index) => {
      append("proposal-content", schemas.makeProposalContent({
        proposalId: proposal.id,
        contentHash: proposal.proposedContentHash,
        contentEncoding: "base64",
        chunkIndex: index,
        chunkCount: chunks.length,
        content: chunk,
      }));
      faultInjection?.("pipeline-after-content-chunk", { proposal, chunkIndex: index, chunkCount: chunks.length });
    });
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
      if (outcome) {
        if (outcome.projectFingerprint !== attempt.projectFingerprint || outcome.clusterId !== attempt.clusterId) throw new Error("synthesis-outcome-binding-mismatch");
        continue;
      }
      const proposal = currentProposal(store, attempt.proposalId);
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
        store.releaseLease?.(key, acquired.nonce);
      }
    }
    return recovered;
  }

  async function runEvolutionCycle({ ctx, sessionID, projectFingerprint, scopeFingerprint, trigger, mode, rootSessionID, rootSessionIDHash, originKind, options = {} }) {
    const auditStart = store.readRecords("audit-event").length;
    const observations = [];
    let eligibility = [];
    try {
      const sessionIDHash = observation.hashSessionLineage(sessionID);
      const lineage = episodeLineage({ sessionID, projectFingerprint, rootSessionID, rootSessionIDHash, originKind, options, schemas, observation });
      const cursorRecord = latestCursor(store, sessionIDHash);
      const cursor = cursorRecord?.payload ?? schemas.makeEpisodeCursor({ sessionIDHash });
      const limit = Math.min(256, Number.isSafeInteger(options.messageLimit) && options.messageLimit > 0 ? options.messageLimit : DEFAULT_MESSAGE_LIMIT);
      const messages = await readSessionMessages(ctx, sessionID, limit, {
        timeoutMs: options.sdkTimeoutMs ?? 15_000,
        label: "Self-evolve durable session.messages",
      });
      const messageHashes = messages.map((message) => observation.hashMessageCursor(message));
      const lastObservedMessageHash = messageHashes.at(-1) ?? null;
      if (cursorRecord && messages.length === 0) {
        appendAudit("message-window-empty", sessionIDHash, { sessionIDHash, preservedMessageHash: cursor.lastObservedMessageHash });
        return {
          result: "no-eligible",
          cycleOutcome: "no-observations",
          cycleReason: "empty-window",
          observations,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: "Self-evolve received an empty message window and preserved the prior cursor without creating evidence. No files were applied.",
        };
      }
      if (cursorRecord && cursor.lastObservedMessageHash === lastObservedMessageHash) {
        const proposal = pendingProposal(store, projectFingerprint);
        return {
          result: proposal ? "proposal-pending" : "no-eligible",
          cycleOutcome: "cursor-unchanged",
          cycleReason: "already-processed",
          ...(proposal ? { proposal } : {}),
          observations,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: proposal
            ? `${proposalText(proposal, mode)}\nThis cursor was already processed; no duplicate observations or synthesis were created.`
            : "Self-evolve skipped this scan because this session message cursor was already processed. No files were applied.",
        };
      }

      const priorIndex = cursor.lastObservedMessageHash === null ? -1 : messageHashes.lastIndexOf(cursor.lastObservedMessageHash);
      const timestamp = now();
      const nextCursor = schemas.makeEpisodeCursor({ sessionIDHash, lastIdleAt: timestamp, lastObservedMessageHash, leaseNonce: null });
      const advanceCursor = () => {
        if (cursorRecord) {
          const updated = store.runCas(
            "episode-cursor",
            cursor.sessionIDHash,
            cursor.lastObservedMessageHash,
            () => nextCursor,
            (payload) => payload?.lastObservedMessageHash,
          );
          if (!updated?.ok) throw new Error(updated?.reason ?? "cursor-cas-failed");
        } else {
          append("episode-cursor", nextCursor, timestamp);
        }
      };
      if (cursor.lastObservedMessageHash !== null && priorIndex < 0) {
        advanceCursor();
        appendAudit("message-cursor-gap", sessionIDHash, { sessionIDHash, priorMessageHash: cursor.lastObservedMessageHash, lastObservedMessageHash });
        return {
          result: "no-eligible",
          cycleOutcome: "no-observations",
          cycleReason: "cursor-gap",
          observations,
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
        messages: metadataMessages(unseenMessages, privacy),
      };
      const receipts = observation.extractReceipts(episode, { projectFingerprint, scopeFingerprint, now: timestamp });
      const injectionFlagged = episode.messages.some((message) => message.injectionFlagged === true);
      for (const receipt of receipts) {
        append("receipt", receipt, timestamp);
        const incidentId = observation.hashSignature(`self-evolve-incident-v1\n${sessionIDHash}\n${cursor.lastObservedMessageHash ?? "start"}\n${lastObservedMessageHash ?? "empty"}\n${receipt.signatureHash}`);
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
        });
        const scrubbed = privacy.scrubObservation(candidate);
        if (!scrubbed?.ok) throw new Error(`observation-rejected:${scrubbed?.reason ?? "unknown"}`);
        append("observation", scrubbed.sanitized ?? scrubbed.observation ?? scrubbed, timestamp);
        observations.push(scrubbed.sanitized ?? scrubbed.observation ?? scrubbed);
      }

      advanceCursor();

      const allObservations = store.readRecords("observation").map((record) => record.payload)
        .filter((item) => item.projectFingerprint === projectFingerprint && privacy.isObservationEligible?.(item.id) !== false);
      const clusters = observation.correlateObservations(allObservations);
      eligibility = observation.evaluateEligibility(clusters, { now: timestamp, ...(options.eligibility ?? {}) });
      clusters.forEach((cluster) => append("evidence-cluster", cluster, timestamp));
      eligibility.forEach((item) => append("eligibility-explanation", item, timestamp));
      const proposedClusterIds = new Set([...latestByLogicalId(store.readRecords("proposal")).values()]
        .map((record) => record.payload)
        .filter((proposal) => ["critic-pending", "pending", "approved", "applied"].includes(proposal.state))
        .map((proposal) => proposal.clusterId));
      const eligible = clusters.flatMap((cluster) => {
        const explanation = eligibility.find((item) => item.clusterId === cluster.id);
        if (!explanation?.eligible || proposedClusterIds.has(cluster.id)) return [];
        return [{
          ...cluster,
          observations: allObservations.filter((item) => cluster.incidentIds.includes(item.incidentId)),
          eligibility: explanation,
          injectionFlagged: allObservations.some((item) => cluster.incidentIds.includes(item.incidentId) && item.injectionFlagged),
        }];
      });
      if (!eligible.length) {
        return {
          result: "no-eligible",
          cycleOutcome: observations.length ? "not-eligible" : "no-observations",
          cycleReason: "insufficient-evidence",
          observations,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: noEligibleText(eligibility),
        };
      }

      const records = inventoryFor(options);
      const targetSkill = targetFor(records, options);
      if (!targetSkill) throw new Error("eligible-cluster-has-no-skill-target");
      const captured = new Map();
      const synthesisCtx = captureSynthesisContent(ctx, captured);
      let validNoChange = false;
      let hadSynthesisFailure = false;
      for (const cluster of eligible) {
        if (typeof options.reservePassiveProviderCalls === "function") {
          let reservation;
          try {
            reservation = await options.reservePassiveProviderCalls(2, { clusterID: cluster.id, projectFingerprint });
          } catch (error) {
            reservation = { ok: false, reason: String(error?.message ?? error) };
          }
          if (!reservation?.ok) {
            const reason = String(reservation?.reason ?? "passive-provider-budget-reservation-failed");
            appendAudit("pipeline-passive-provider-reservation-denied", cluster.id, {
              reason,
              requested: 2,
              remaining: Number.isSafeInteger(reservation?.remaining) ? reservation.remaining : -1,
            });
            return {
              result: "deferred",
              cycleOutcome: "deferred",
              deferred: true,
              reason,
              requested: 2,
              ...(Number.isSafeInteger(reservation?.remaining) ? { remaining: reservation.remaining } : {}),
              observations,
              eligibility,
              auditEvents: auditSince(store, auditStart),
              responseText: `Self-evolve deferred synthesis because two passive provider slots could not be reserved: ${reason}. Neither hidden session was started.`,
            };
          }
        }
        const synthesized = await synthesis.runSynthesis({
          ctx: synthesisCtx,
          cluster,
          targetSkill,
          inventory: records,
          privacy,
          options: { store, currentContent: options.currentContent ?? targetSkill.currentContent ?? "", eligibility: cluster.eligibility, faultInjection: options.faultInjection, ...(options.synthesis ?? {}) },
          now: timestamp,
        });
        if (!synthesized?.ok || !synthesized.proposal) {
          appendAudit("pipeline-synthesis-failure", cluster.id, { reason: synthesized?.reason ?? (synthesized?.noChange ? "no-change" : "unknown") });
          persistSynthesisOutcome(synthesized, synthesized?.noChange ? "no-change" : "failed", synthesized?.reason, options.faultInjection);
          if (synthesized?.ok === true && synthesized?.noChange === true) validNoChange = true;
          else hadSynthesisFailure = true;
          continue;
        }
        const cleanProposal = schemas.makeProposal(synthesized.proposal);
        if (!currentProposal(store, cleanProposal.id)) append("proposal", cleanProposal, timestamp);
         const criticized = await synthesis.runCritic({
          ctx: synthesisCtx,
          proposal: cleanProposal,
          cluster,
          inventory: records,
           options: { store, attemptLease: synthesized.lease, ...(options.critic ?? {}) },
          now: timestamp,
         });
        options.faultInjection?.("pipeline-after-critic-transaction", { synthesized, criticized });
        if (!criticized?.ok || !criticized.proposal?.criticPassed) {
          hadSynthesisFailure = true;
          appendAudit("pipeline-critic-failure", cleanProposal.id, { reason: criticized?.reason ?? "critic-rejected" });
          persistSynthesisOutcome(synthesized, criticized?.criticResult ? "critic-rejected" : "failed", criticized?.reason, options.faultInjection);
          continue;
        }
        const proposal = criticized.proposal;
        const content = synthesized.proposal.proposedContent ?? captured.get(proposal.proposedContentHash);
        try {
          persistProposalContent(proposal, content, options.faultInjection);
          options.faultInjection?.("pipeline-after-content-chunks", { proposal });
        } catch (error) {
          hadSynthesisFailure = true;
          const reason = String(error?.message ?? error) === "proposal-content-unavailable"
            ? "proposal-content-unavailable"
            : "proposal-content-persistence-failed";
          failProposalClosed(proposal, reason);
          persistSynthesisOutcome(synthesized, "failed", reason, options.faultInjection);
          try { appendAudit("pipeline-proposal-content-failure", proposal.id, { reason }); } catch {}
          continue;
        }
        persistSynthesisOutcome(synthesized, "accepted", undefined, options.faultInjection);
        if (mode === "yolo") {
          const applied = await applier.applyProposal({ proposal: { ...proposal, proposedContent: content }, mode, actor: "self-evolve-applier" });
          if (applied?.ok === true && applied.disposition === "applied") {
            return {
              result: "applied",
              cycleOutcome: "applied",
              proposal,
              observations,
              eligibility,
              auditEvents: auditSince(store, auditStart),
              responseText: `Self-evolve applied proposal ${proposal.id}; appliedHash ${applied.appliedHash}; auditId ${applied.auditId}.`,
            };
          }
          const latest = currentProposal(store, proposal.id) ?? proposal;
          if (applied?.disposition === "deferred" && applied.deferred === true) {
            return {
              result: "deferred",
              cycleOutcome: "deferred",
              deferred: true,
              reason: applied.reason ?? "apply-deferred",
              proposal: latest,
              observations,
              eligibility,
              auditEvents: auditSince(store, auditStart),
              responseText: `Self-evolve deferred automatic application of proposal ${proposal.id}: ${applied.reason ?? "apply-deferred"}.`,
            };
          }
          if (applied?.disposition !== "pending-review" || latest.state !== "pending") {
            const reason = String(applied?.reason ?? "invalid-automatic-apply-outcome").slice(0, 400);
            const failed = failProposalClosed(latest, reason);
            return {
              result: "failed-closed",
              cycleOutcome: "failed-closed",
              reason,
              proposal: failed,
              observations,
              eligibility,
              auditEvents: auditSince(store, auditStart),
              responseText: `Self-evolve automatic application of proposal ${proposal.id} failed closed: ${reason}. No verified skill-file change was accepted.`,
            };
          }
        }
        return {
          result: mode === "manual" ? "proposal-pending" : "proposal-ready",
          cycleOutcome: "recommendation-created",
          proposal,
          observations,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: proposalText(proposal, mode),
        };
      }
      if (validNoChange && !hadSynthesisFailure) {
        return {
          result: "no-change",
          cycleOutcome: "valid-no-change",
          cycleReason: "no-change",
          observations,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: "Self-evolve analysis completed successfully and found no useful safe change. No files were applied.",
        };
      }
      return {
        result: "failed-closed",
        cycleOutcome: "failed-closed",
        observations,
        eligibility,
        auditEvents: auditSince(store, auditStart),
        responseText: "Self-evolve evidence was eligible, but synthesis or critic validation failed closed. No files were applied.",
      };
    } catch (error) {
      try { appendAudit("pipeline-failure", observation.hashSessionLineage(sessionID), { reason: String(error?.message ?? error).slice(0, 400), trigger: String(trigger?.reason ?? trigger?.kind ?? trigger ?? "manual") }); } catch {}
      return {
        result: "failed-closed",
        cycleOutcome: "failed-closed",
        observations,
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

  function close() {
    applier.close?.();
    synthesis.disposeSynthesis?.(store);
    store.close?.();
  }

  return Object.freeze({ runEvolutionCycle, runApprovalFlow, runRollbackFlow, runRecoveryOnStartup, recoverSynthesisAttempts, readProposalContent, close });
}
