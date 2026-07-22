const DEFAULT_MESSAGE_LIMIT = 120;
const CONTENT_CHUNK_SIZE = 400;

function messageList(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.data?.messages)) return result.data.messages;
  if (Array.isArray(result?.messages)) return result.messages;
  return [];
}

async function readMessages(ctx, sessionID, limit) {
  const method = ctx?.client?.session?.messages;
  if (typeof method !== "function") throw new Error("session.messages-unavailable");
  let lastError;
  for (const invoke of [
    () => method.call(ctx.client.session, { path: { id: sessionID }, query: { directory: ctx.directory, limit } }),
    () => method.call(ctx.client.session, { path: { sessionID }, query: { directory: ctx.directory, limit } }),
    () => method.call(ctx.client.session, { sessionID, directory: ctx.directory, limit }),
  ]) {
    try {
      const result = await invoke();
      if (!result?.error) return messageList(result).slice(-limit);
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(String(lastError?.message ?? lastError ?? "session-messages-failed"));
}

function messageText(message) {
  const parts = message?.parts ?? message?.info?.parts ?? message?.message?.parts ?? [];
  const text = Array.isArray(parts)
    ? parts.map((part) => part?.text ?? part?.content ?? "").filter(Boolean).join("\n")
    : "";
  return text || String(message?.text ?? message?.content ?? message?.info?.text ?? "");
}

function messageRole(message) {
  return message?.role ?? message?.info?.role ?? message?.type ?? "message";
}

function selfEvolveOutput(message) {
  const parts = message?.parts ?? message?.info?.parts ?? [];
  return message?.agent === "self-evolve-synthesizer"
    || message?.agent === "self-evolve-critic"
    || (Array.isArray(parts) && parts.some((part) => part?.metadata?.source === "self-evolve-plugin"));
}

function metadataMessages(messages, privacy) {
  return messages.flatMap((message) => {
    const role = messageRole(message);
    const text = messageText(message).trim();
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
    const toolParts = (message?.parts ?? message?.info?.parts ?? []).filter((part) =>
      part?.type === "tool" && (part?.state?.status === "error" || part?.state?.error));
    return [base, ...toolParts.map((part) => ({
      role: "tool",
      toolName: String(part.tool ?? part.name ?? "tool").slice(0, 128),
      toolError: String(part.state?.error ?? part.state?.status ?? "error").slice(0, 128),
      isSelfEvolveOutput: base.isSelfEvolveOutput,
    }))];
  });
}

function latestByLogicalId(records) {
  const latest = new Map();
  for (const record of records) latest.set(record.payload?.id ?? record.payload?.proposalId ?? record.id, record);
  return latest;
}

function currentProposal(store, proposalId) {
  return latestByLogicalId(store.readRecords("proposal")).get(proposalId)?.payload ?? null;
}

function pendingProposal(store, projectFingerprint) {
  return [...latestByLogicalId(store.readRecords("proposal")).values()]
    .map((record) => record.payload)
    .findLast((proposal) => proposal.projectFingerprint === projectFingerprint && proposal.state === "pending") ?? null;
}

function latestCursor(store, sessionID) {
  return store.readRecords("episode-cursor").filter((record) => record.payload.sessionID === sessionID).at(-1) ?? null;
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
    `Approve separately: /self-evolve approve ${proposal.id}`,
    "No files were applied by this scan.",
  ].join("\n");
}

function noEligibleText(eligibility) {
  const reasons = [...new Set(eligibility.flatMap((item) => item.reasons ?? []))];
  return `Self-evolve recorded bounded observations but no evidence cluster is eligible. ${reasons.length ? `Unmet gates: ${reasons.join(", ")}. ` : ""}No files were applied.`;
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

  function inventoryFor(options) {
    if (Array.isArray(options.inventoryRecords)) return options.inventoryRecords;
    const roots = options.canonicalRoots ?? inventory.loadAllowlist?.({
      globalSkillRoots: options.globalSkillRoots ?? store.getSettings?.().global.allowedSkillRoots ?? [],
      repoSkillRoots: options.repoSkillRoots ?? [],
      projectRoot: options.projectRoot,
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
            const result = await prompt.apply(ctx.client.session, args);
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

  function persistProposalContent(proposal, content) {
    if (typeof content !== "string" || inventory.hashSkillContent?.(content) !== proposal.proposedContentHash) {
      throw new Error("proposal-content-unavailable");
    }
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const chunks = encoded.match(new RegExp(`.{1,${CONTENT_CHUNK_SIZE}}`, "gu")) ?? [""];
    chunks.forEach((chunk, index) => appendAudit("proposal-content", proposal.id, {
      contentHash: proposal.proposedContentHash,
      contentEncoding: "base64",
      chunkIndex: index,
      chunkCount: chunks.length,
      content: chunk,
    }));
  }

  function readProposalContent(proposal) {
    if (typeof proposal.proposedContent === "string") return proposal.proposedContent;
    const chunks = store.readRecords("audit-event")
      .map((record) => record.payload)
      .filter((event) => event.details?.action === "proposal-content"
        && event.details?.subjectId === proposal.id
        && event.details?.contentHash === proposal.proposedContentHash)
      .sort((left, right) => left.details.chunkIndex - right.details.chunkIndex);
    if (!chunks.length || chunks.length !== chunks[0].details.chunkCount) return null;
    if (chunks.some((event, index) => event.details.chunkIndex !== index || event.details.chunkCount !== chunks.length)) return null;
    if (chunks.some((event) => event.details.contentEncoding !== "base64")) return null;
    const content = Buffer.from(chunks.map((event) => event.details.content).join(""), "base64").toString("utf8");
    return inventory.hashSkillContent?.(content) === proposal.proposedContentHash ? content : null;
  }

  async function runEvolutionCycle({ ctx, sessionID, projectFingerprint, scopeFingerprint, trigger, mode, options = {} }) {
    const auditStart = store.readRecords("audit-event").length;
    const observations = [];
    let eligibility = [];
    try {
      const cursorRecord = latestCursor(store, sessionID);
      const cursor = cursorRecord?.payload ?? schemas.makeEpisodeCursor({ sessionID });
      const limit = Math.min(256, Number.isSafeInteger(options.messageLimit) && options.messageLimit > 0 ? options.messageLimit : DEFAULT_MESSAGE_LIMIT);
      const messages = await readMessages(ctx, sessionID, limit);
      const messageCount = messages.length;
      if (cursor.lastObservedMessageCount === messageCount) {
        const proposal = pendingProposal(store, projectFingerprint);
        return {
          result: proposal ? "proposal-pending" : "no-eligible",
          ...(proposal ? { proposal } : {}),
          observations,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: proposal
            ? `${proposalText(proposal, mode)}\nThis cursor was already processed; no duplicate observations or synthesis were created.`
            : "Self-evolve skipped this scan because this session message cursor was already processed. No files were applied.",
        };
      }

      const timestamp = now();
      const episode = {
        sessionID,
        projectFingerprint,
        scopeFingerprint,
        startedAt: timestamp,
        endedAt: timestamp,
        messages: metadataMessages(messages, privacy),
      };
      const receipts = observation.extractReceipts(episode, { projectFingerprint, scopeFingerprint, now: timestamp });
      const injectionFlagged = episode.messages.some((message) => message.injectionFlagged === true);
      for (const receipt of receipts) {
        append("receipt", receipt, timestamp);
        const incidentId = observation.hashSignature(`${sessionID}:${messageCount}:${receipt.signatureHash}`).slice(0, 128);
        const candidate = schemas.makeObservation({
          id: observation.hashSignature(JSON.stringify({ incidentId, receipt: receipt.signatureHash })),
          projectFingerprint,
          receiptIds: [receipt.signatureHash],
          structuredFields: receiptFields(receipt),
          incidentId,
          createdAt: timestamp,
          injectionFlagged,
          redacted: true,
        });
        const scrubbed = privacy.scrubObservation(candidate);
        if (!scrubbed?.ok) throw new Error(`observation-rejected:${scrubbed?.reason ?? "unknown"}`);
        append("observation", scrubbed.sanitized ?? scrubbed.observation ?? scrubbed, timestamp);
        observations.push(scrubbed.sanitized ?? scrubbed.observation ?? scrubbed);
      }

      const nextCursor = schemas.makeEpisodeCursor({ sessionID, lastIdleAt: timestamp, lastObservedMessageCount: messageCount, leaseNonce: null });
      if (cursorRecord) {
        const updated = store.runCas("episode-cursor", cursorRecord.id, undefined, () => nextCursor);
        if (!updated?.ok) throw new Error(updated?.reason ?? "cursor-cas-failed");
      } else {
        append("episode-cursor", nextCursor, timestamp);
      }

      const allObservations = store.readRecords("observation").map((record) => record.payload)
        .filter((item) => item.projectFingerprint === projectFingerprint && privacy.isObservationEligible?.(item.id) !== false);
      const clusters = observation.correlateObservations(allObservations);
      eligibility = observation.evaluateEligibility(clusters, { now: timestamp, ...(options.eligibility ?? {}) });
      clusters.forEach((cluster) => append("evidence-cluster", cluster, timestamp));
      eligibility.forEach((item) => append("eligibility-explanation", item, timestamp));
      const proposedClusterIds = new Set(store.readRecords("proposal").map((record) => record.payload.clusterId));
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
        return { result: "no-eligible", observations, eligibility, auditEvents: auditSince(store, auditStart), responseText: noEligibleText(eligibility) };
      }

      const records = inventoryFor(options);
      const targetSkill = targetFor(records, options);
      if (!targetSkill) throw new Error("eligible-cluster-has-no-skill-target");
      const captured = new Map();
      const synthesisCtx = captureSynthesisContent(ctx, captured);
      for (const cluster of eligible) {
        const synthesized = await synthesis.runSynthesis({
          ctx: synthesisCtx,
          cluster,
          targetSkill,
          inventory: records,
          privacy,
          options: { store, currentContent: options.currentContent ?? targetSkill.currentContent ?? "", eligibility: cluster.eligibility, ...(options.synthesis ?? {}) },
          now: timestamp,
        });
        if (!synthesized?.ok || !synthesized.proposal) {
          appendAudit("pipeline-synthesis-failure", cluster.id, { reason: synthesized?.reason ?? (synthesized?.noChange ? "no-change" : "unknown") });
          continue;
        }
        const cleanProposal = schemas.makeProposal(synthesized.proposal);
        if (!currentProposal(store, cleanProposal.id)) append("proposal", cleanProposal, timestamp);
        const criticized = await synthesis.runCritic({
          ctx: synthesisCtx,
          proposal: cleanProposal,
          cluster,
          inventory: records,
          options: { store, ...(options.critic ?? {}) },
          now: timestamp,
        });
        if (!criticized?.ok || !criticized.proposal?.criticPassed) {
          appendAudit("pipeline-critic-failure", cleanProposal.id, { reason: criticized?.reason ?? "critic-rejected" });
          continue;
        }
        const proposal = criticized.proposal;
        const content = synthesized.proposal.proposedContent ?? captured.get(proposal.proposedContentHash);
        persistProposalContent(proposal, content);
        if (mode === "yolo") {
          const applied = await applier.applyProposal({ proposal: { ...proposal, proposedContent: content }, mode, actor: "self-evolve-applier" });
          if (applied?.ok) return { result: "applied", proposal, observations, eligibility, auditEvents: auditSince(store, auditStart), responseText: `Self-evolve applied proposal ${proposal.id}; appliedHash ${applied.appliedHash}; auditId ${applied.auditId}.` };
        }
        return {
          result: mode === "manual" ? "proposal-pending" : "proposal-ready",
          proposal,
          observations,
          eligibility,
          auditEvents: auditSince(store, auditStart),
          responseText: proposalText(proposal, mode),
        };
      }
      return { result: "failed-closed", observations, eligibility, auditEvents: auditSince(store, auditStart), responseText: "Self-evolve evidence was eligible, but synthesis or critic validation failed closed. No files were applied." };
    } catch (error) {
      try { appendAudit("pipeline-failure", sessionID, { reason: String(error?.message ?? error).slice(0, 400), trigger: String(trigger?.reason ?? trigger?.kind ?? trigger ?? "manual") }); } catch {}
      return { result: "failed-closed", observations, eligibility, auditEvents: auditSince(store, auditStart), responseText: `Self-evolve failed closed: ${String(error?.message ?? error)}. No files were applied.` };
    }
  }

  async function runApprovalFlow({ ctx, proposalId, actor, mode, projectFingerprint }) {
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
    const result = await applier.applyProposal({ ctx, proposal: { ...proposal, proposedContent: content }, decision, actor, mode: effectiveMode, headless: false });
    return result?.ok
      ? { result: "applied", auditEvents: auditSince(store, auditStart), responseText: `Applied proposal ${proposalId}; appliedHash ${result.appliedHash}; auditId ${result.auditId}.` }
      : { result: "failed-closed", auditEvents: auditSince(store, auditStart), responseText: `Proposal ${proposalId} was not applied: ${result?.reason ?? "apply-failed"}.` };
  }

  async function runRollbackFlow({ ctx, proposalId, actor, reason }) {
    const auditStart = store.readRecords("audit-event").length;
    const result = await applier.rollbackApplied({ ctx, proposalId, actor, reason });
    return result?.ok
      ? { result: "rolled-back", auditEvents: auditSince(store, auditStart), responseText: `Rolled back proposal ${proposalId}; restored hash ${result.rolledBackHash}.` }
      : { result: "failed-closed", auditEvents: auditSince(store, auditStart), responseText: `Rollback for proposal ${proposalId} failed closed: ${result?.reason ?? "rollback-failed"}.` };
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
    synthesis.disposeSynthesis?.();
    store.close?.();
  }

  return Object.freeze({ runEvolutionCycle, runApprovalFlow, runRollbackFlow, runRecoveryOnStartup, close });
}
