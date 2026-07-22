import { createHash, randomBytes } from "node:crypto";

const RESTART_REMINDER = "OpenCode must be restarted for the new skill content to load in existing sessions; new sessions will pick it up automatically.";
const DEFAULT_ROLLOUT_GATES = Object.freeze({
  offlineCorpus: false,
  passiveShadowObservation: false,
  automaticSynthesisApplicationDisabled: false,
  autoReviewRollout: true,
  yoloEnablementThreshold: Object.freeze({ minSynthesesObserved: 10, minSuccessRate: 0.8 }),
});
const HIDDEN_ANALYZER_AGENTS = new Set([
  "self-evolve-analyzer",
  "self-evolve-synthesizer",
  "self-evolve-critic",
]);
const TERMINAL_SESSION_STATES = new Set(["aborted", "cancelled", "completed", "error", "failed", "idle"]);

export const ROLLOUT_GATES = DEFAULT_ROLLOUT_GATES;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function errorReason(error) {
  return String(error?.message ?? error ?? "unknown-error").split(":", 1)[0];
}

function listedSessions(result) {
  const value = result?.data ?? result;
  if (Array.isArray(value)) return value;
  return value?.sessions ?? value?.items ?? [];
}

function analyzerSessionState(session) {
  return String(session?.state ?? session?.status?.type ?? session?.status ?? "").toLowerCase();
}

async function abortSession(client, directory, id) {
  const abort = client?.session?.abort;
  if (typeof abort !== "function") throw new Error("session-abort-unavailable");
  let lastError;
  for (const args of [{ path: { id }, query: { directory } }, { path: { sessionID: id }, query: { directory } }, { sessionID: id, directory }, { id }, id]) {
    try {
      const result = await abort.call(client.session, args);
      if (!result?.error) return;
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("session-abort-failed");
}

async function recoverOrphanedAnalyzerSessions(client, directory) {
  const list = client?.session?.list;
  if (typeof list !== "function") return [];
  const result = await list.call(client.session, { query: { directory } });
  const candidates = listedSessions(result).filter((session) => {
    const agent = session?.agent ?? session?.mode ?? session?.info?.agent;
    const state = analyzerSessionState(session);
    return HIDDEN_ANALYZER_AGENTS.has(agent) && state && !TERMINAL_SESSION_STATES.has(state);
  });
  const outcomes = [];
  for (const session of candidates) {
    const id = session?.id ?? session?.sessionID;
    if (!id) continue;
    try {
      await abortSession(client, directory, id);
      outcomes.push({ id, ok: true });
    } catch (error) {
      outcomes.push({ id, ok: false, reason: errorReason(error) });
    }
  }
  return outcomes;
}

function latestById(records) {
  const latest = new Map();
  for (const record of records ?? []) latest.set(record.payload?.id ?? record.payload?.proposalId ?? record.id, record.payload ?? record);
  return latest;
}

function frozenRolloutGates(value = {}) {
  const threshold = value.yoloEnablementThreshold ?? {};
  const integer = Number.isSafeInteger(threshold.minSynthesesObserved) && threshold.minSynthesesObserved >= 0
    ? threshold.minSynthesesObserved
    : DEFAULT_ROLLOUT_GATES.yoloEnablementThreshold.minSynthesesObserved;
  const rate = Number.isFinite(threshold.minSuccessRate) && threshold.minSuccessRate >= 0 && threshold.minSuccessRate <= 1
    ? threshold.minSuccessRate
    : DEFAULT_ROLLOUT_GATES.yoloEnablementThreshold.minSuccessRate;
  return Object.freeze({
    offlineCorpus: value.offlineCorpus === true,
    passiveShadowObservation: value.passiveShadowObservation === true,
    automaticSynthesisApplicationDisabled: value.automaticSynthesisApplicationDisabled === true,
    autoReviewRollout: value.autoReviewRollout !== false,
    yoloEnablementThreshold: Object.freeze({ minSynthesesObserved: integer, minSuccessRate: rate }),
  });
}

function instantiate(dependency, factoryName, args) {
  return typeof dependency?.[factoryName] === "function" ? dependency[factoryName](args) : dependency;
}

export function createIntegration({
  store,
  inventory,
  privacy,
  schemas,
  observation,
  synthesisModule,
  applier,
  commands,
  pipeline,
  scheduler,
  options = {},
  now = () => Date.now(),
} = {}) {
  if (!store || !schemas || !pipeline || !scheduler || !applier) throw new TypeError("integration-dependencies-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  const rolloutGates = frozenRolloutGates(options.rolloutGates ?? options.settings?.rolloutGates);
  const inFlight = new Map();
  const downgraded = new Set();
  let runtimeKillSwitch = process.env.SELF_EVOLVE_KILL === "1" || process.env.SELF_EVOLVE_KILL === "true";
  let corrupt = false;
  let lastError;
  let hostVersion = String(options.hostVersion ?? "unknown");
  let ctx = options.ctx;
  let closed = false;

  function settings() {
    try {
      const value = store.getSettings();
      if (!value?.global || !value?.repo) throw new Error("corrupt-settings");
      return value;
    } catch (error) {
      corrupt = true;
      lastError = errorReason(error);
      return null;
    }
  }

  function circuitBreakerOpen() {
    try {
      return applier.circuitBreakerOpen?.() === true
        || schedulerInstance?.getCircuitBreaker?.().open === true
        || store.readRecords?.("circuit-breaker").at(-1)?.payload?.open === true;
    } catch {
      return true;
    }
  }

  function modeOverrides(current, projectFingerprint) {
    const processExcluded = options.processExcluded === true
      || options.processExcluded?.has?.(projectFingerprint) === true
      || (typeof options.processExcluded === "function" && options.processExcluded(projectFingerprint) === true)
      || (projectFingerprint !== undefined && current?.repo?.projectFingerprint !== projectFingerprint);
    return {
      killSwitchActive: runtimeKillSwitch || current?.global?.killSwitchActive === true,
      paused: current?.global?.paused === true,
      circuitBreakerOpen: circuitBreakerOpen(),
      processExcluded,
      repoOptOut: current?.repo?.excluded === true || options.repoOptOut === true,
      hostSupported: options.hostSupported !== false,
      corrupt: corrupt || !current,
    };
  }

  function resolveEffectiveMode(projectFingerprint) {
    const current = settings();
    const mode = schemas.resolveMode(current?.global?.mode ?? "manual", current?.repo?.mode ?? "inherit", modeOverrides(current, projectFingerprint));
    return schemas.Mode?.values?.includes(mode) ? mode : "manual";
  }

  function rolloutMetrics() {
    const supplied = typeof options.getRolloutMetrics === "function" ? options.getRolloutMetrics() : options.rolloutMetrics;
    if (supplied) return supplied;
    const records = store.readRecords?.("audit-event") ?? [];
    const synthesis = records.filter((record) => /^synthesis-|^pipeline-(?:synthesis|critic)-/u.test(String(record.payload?.details?.action ?? "")));
    const failures = synthesis.filter((record) => /failure/u.test(String(record.payload?.details?.action ?? ""))).length;
    return { synthesesObserved: synthesis.length, successRate: synthesis.length ? (synthesis.length - failures) / synthesis.length : 0 };
  }

  function yoloThresholdMet() {
    const metrics = rolloutMetrics() ?? {};
    const threshold = rolloutGates.yoloEnablementThreshold;
    return Number(metrics.synthesesObserved ?? 0) >= threshold.minSynthesesObserved
      && Number(metrics.successRate ?? 0) >= threshold.minSuccessRate;
  }

  function targetAllowlisted(proposal, current = settings()) {
    const root = proposal?.skillTarget?.canonicalRoot;
    return typeof root === "string" && (current?.global?.allowedSkillRoots ?? []).includes(root);
  }

  function releaseGatesPassed(proposal) {
    return proposal?.criticPassed === true
      && proposal?.validDeterministic === true
      && proposal?.injectionFlagged !== true
      && !rolloutGates.automaticSynthesisApplicationDisabled
      && yoloThresholdMet();
  }

  function evaluateAuthority({ proposal, decision, mode, headless = false }) {
    const current = settings();
    const effectiveMode = resolveEffectiveMode(proposal?.projectFingerprint);
    const requestedMode = mode === effectiveMode ? mode : effectiveMode;
    const exactApproval = decision?.proposalId === proposal?.id
      && decision?.targetHash === proposal?.skillTarget?.currentHash
      && decision?.proposedContentHash === proposal?.proposedContentHash
      && decision?.newState === "approved";
    return schemas.evaluateApplyAuthority({
      mode: requestedMode,
      decisionApproved: exactApproval,
      allowlisted: targetAllowlisted(proposal, current),
      releaseGatesPassed: releaseGatesPassed(proposal),
      headless,
      killSwitchActive: runtimeKillSwitch || current?.global?.killSwitchActive === true,
    });
  }

  const guardedApplier = Object.freeze({
    ...applier,
    async applyProposal(args = {}) {
      const authority = evaluateAuthority(args);
      if (!authority.allowed) return { ok: false, reason: authority.reason };
      return applier.applyProposal(args);
    },
  });

  const commandPolicy = instantiate(commands, "createCommandPolicy", {
    store,
    privacy,
    schemaVersion: schemas.SCHEMA_VERSION,
    hostVersion,
    now,
  });
  const integratedSynthesis = rolloutGates.passiveShadowObservation
    ? Object.freeze({
        ...synthesisModule,
        runSynthesis: async () => ({ ok: true, proposal: null, noChange: true, shadowObservation: true }),
      })
    : synthesisModule;
  let pipelineInstance = instantiate(pipeline, "createPipeline", {
    store,
    inventory,
    privacy,
    synthesis: integratedSynthesis,
    applier: guardedApplier,
    commands: commandPolicy,
    schemas,
    observation,
    now,
  });

  async function enqueueWork(workItem) {
    const key = `${workItem.sessionID}:${workItem.leaseNonce ?? workItem.epoch ?? now()}`;
    const item = { ...workItem, key, mode: resolveEffectiveMode(workItem.projectFingerprint), stage: "pipeline", startedAt: now() };
    inFlight.set(key, item);
    let result;
    try {
      result = await runEvolutionCycle({ ...workItem, ctx, trigger: workItem.trigger ?? "scheduler" });
      return result;
    } catch (error) {
      result = { ok: false, error: errorReason(error) };
      throw error;
    } finally {
      inFlight.delete(key);
      if (!downgraded.delete(key)) schedulerInstance.recordWorkResult?.(workItem, result);
    }
  }

  const schedulerInstance = instantiate(scheduler, "createScheduler", {
    store,
    privacy,
    budgets: options.budgets,
    now,
    enqueueWork,
    log: options.log,
  });

  function appendAudit(kind, details, proposalId, actor = "self-evolve-integration") {
    const timestamp = now();
    const clean = Object.fromEntries(Object.entries(details).filter(([, value]) => ["string", "boolean", "number"].includes(typeof value) || value === null));
    const payloadHash = sha256(JSON.stringify(clean));
    const event = schemas.makeAuditEvent({
      id: sha256(JSON.stringify({ kind, proposalId, actor, timestamp, payloadHash, nonce: randomBytes(8).toString("hex") })),
      kind,
      ...(proposalId ? { proposalId } : {}),
      actor,
      timestamp,
      payloadHash,
      details: clean,
    });
    const saved = store.appendRecord(schemas.wrapRecord("audit-event", event, timestamp));
    if (!saved?.ok) throw new Error(saved?.reason ?? "audit-write-failed");
    return event;
  }

  function publish(type, properties = {}) {
    const method = ctx?.client?.tui?.publish;
    if (typeof method !== "function") return;
    Promise.resolve(method.call(ctx.client.tui, { type, properties })).catch((error) => { lastError = errorReason(error); });
  }

  function syncSchedulerMode(projectFingerprint, reason = "settings-refresh") {
    const mode = resolveEffectiveMode(projectFingerprint);
    schedulerInstance.setMode?.(mode, reason);
    return mode;
  }

  function currentProposal(proposalId) {
    return latestById(store.readRecords?.("proposal") ?? []).get(proposalId) ?? null;
  }

  function proposalContent(proposal) {
    if (typeof proposal?.proposedContent === "string") return proposal.proposedContent;
    const chunks = (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).filter((event) =>
      event.details?.action === "proposal-content"
      && event.details?.subjectId === proposal.id
      && event.details?.contentHash === proposal.proposedContentHash)
      .sort((left, right) => left.details.chunkIndex - right.details.chunkIndex);
    if (!chunks.length || chunks.length !== chunks[0].details.chunkCount) return "";
    return Buffer.from(chunks.map((event) => event.details.content).join(""), "base64").toString("utf8");
  }

  function eligibilityFor(proposal) {
    return (store.readRecords?.("eligibility-explanation") ?? []).map((record) => record.payload)
      .findLast((item) => item.clusterId === proposal.clusterId) ?? { clusterId: proposal.clusterId, eligible: false, reasons: ["eligibility-record-unavailable"], thresholdsMet: {}, thresholdsMissed: {} };
  }

  function makeDecision(proposal, newState, actor = "self-evolve-integration", priorState = proposal.state) {
    const timestamp = now();
    return schemas.makeDecision({
      proposalId: proposal.id,
      targetHash: proposal.skillTarget.currentHash,
      proposedContentHash: proposal.proposedContentHash,
      decisionVersion: proposal.decisionVersion + 1,
      actor,
      timestamp,
      nonce: sha256(`${proposal.id}:${proposal.decisionVersion + 1}:${timestamp}:${newState}:${randomBytes(8).toString("hex")}`),
      priorState,
      newState,
    });
  }

  function persistDecision(decision) {
    const saved = store.appendRecord(schemas.wrapRecord("decision", decision, decision.timestamp));
    return saved?.ok ? { ok: true } : { ok: false, reason: saved?.reason ?? "decision-write-failed" };
  }

  function casDecision(proposal, decision) {
    let transition;
    const cas = store.runCas("proposal", proposal.id, decision.priorState, (current) => {
      transition = schemas.transitionProposalState(current, decision, now());
      if (!transition.ok) throw new Error(transition.error);
      return transition.state;
    });
    if (!cas?.ok) return { ok: false, reason: cas?.reason ?? "cas-failed" };
    const persisted = persistDecision(decision);
    return persisted.ok ? { ok: true, proposal: cas.newRecord.payload, auditEvent: transition.events[0] } : persisted;
  }

  function markApplied(proposalId) {
    const proposal = currentProposal(proposalId);
    if (!proposal || proposal.state !== "approved") return;
    const decision = makeDecision(proposal, "applied", "self-evolve-applier");
    casDecision(proposal, decision);
  }

  async function runEvolutionCycle(args = {}) {
    const mode = syncSchedulerMode(args.projectFingerprint, "cycle-refresh");
    const cycleOptions = {
      ...(args.options ?? {}),
      rolloutGates,
      stopAfter: rolloutGates.passiveShadowObservation ? "correlate" : args.options?.stopAfter,
    };
    const pipelineMode = rolloutGates.automaticSynthesisApplicationDisabled || (mode === "auto" && !rolloutGates.autoReviewRollout) ? "manual" : mode;
    const result = await pipelineInstance.runEvolutionCycle({ ...args, ctx: args.ctx ?? ctx, mode: pipelineMode, options: cycleOptions });
    if (result?.result === "applied") {
      markApplied(result.proposal?.id);
      return { ...result, responseText: `${result.responseText}\n${RESTART_REMINDER}` };
    }
    return result;
  }

  async function runApprovalFlow(args = {}) {
    let proposal = currentProposal(args.proposalId);
    const mode = resolveEffectiveMode(args.projectFingerprint ?? proposal?.projectFingerprint);
    if (!proposal) return { result: "failed-closed", responseText: `Proposal ${args.proposalId} was not found.` };
    let decision = (store.readRecords?.("decision") ?? []).map((record) => record.payload).findLast((item) => item.proposalId === proposal.id && item.newState === "approved");
    const authority = evaluateAuthority({ proposal, decision, mode, headless: args.headless === true });
    if (!authority.allowed) return { result: "failed-closed", reason: authority.reason, responseText: `Proposal ${proposal.id} was not applied: ${authority.reason}.` };
    if (mode === "yolo" && proposal.state === "pending") {
      decision = makeDecision(proposal, "approved", "self-evolve-applier");
      const changed = casDecision(proposal, decision);
      if (!changed.ok) return { result: "failed-closed", reason: changed.reason, responseText: `Proposal ${proposal.id} was not applied: ${changed.reason}.` };
      proposal = changed.proposal;
    }
    const result = await pipelineInstance.runApprovalFlow({ ...args, ctx: args.ctx ?? ctx, mode, projectFingerprint: args.projectFingerprint ?? proposal.projectFingerprint });
    if (result?.result === "applied") {
      markApplied(proposal.id);
      return { ...result, responseText: `${result.responseText}\n${RESTART_REMINDER}` };
    }
    return result;
  }

  async function runRollbackFlow(args = {}) {
    return pipelineInstance.runRollbackFlow({ ...args, ctx: args.ctx ?? ctx });
  }

  async function handleEvent(event) {
    const projectFingerprint = event?.properties?.projectFingerprint ?? settings()?.repo?.projectFingerprint;
    const mode = syncSchedulerMode(projectFingerprint, "event-refresh");
    if (mode === "manual") return { scheduled: false, reason: "manual-mode" };
    await schedulerInstance.handleEvent(event);
    return { scheduled: true, mode };
  }

  async function decide({ proposalId, decision, actor } = {}) {
    const id = proposalId ?? decision?.proposalId;
    let proposal = currentProposal(id);
    if (!proposal) return { ok: false, reason: "record-not-found" };
    const requested = decision ?? makeDecision(proposal, "approved", actor);
    if (requested.proposalId !== proposal.id) return { ok: false, reason: "cross-scope" };

    if (requested.newState === "rolled-back") {
      if (proposal.state !== "applied") return { ok: false, reason: "stale-prior-state" };
      const rolledBack = await runRollbackFlow({ proposalId: proposal.id, actor: actor ?? requested.actor, reason: "tui-decision" });
      if (rolledBack.result !== "rolled-back") return { ok: false, reason: "rollback-failed" };
      proposal = currentProposal(id);
      const internal = makeDecision(proposal, "rolled-back", "self-evolve-applier");
      const changed = casDecision(proposal, internal);
      return changed.ok ? { ok: true, auditId: rolledBack.auditEvents?.at(-1)?.id } : changed;
    }

    if (requested.newState === "pending") {
      if (proposal.state !== requested.priorState || proposal.state !== "pending") return { ok: false, reason: "stale-prior-state" };
      const cas = store.runCas("proposal", proposal.id, "pending", (current) => schemas.makeProposal({
        ...current,
        decisionVersion: requested.decisionVersion,
        burnedNonceHashes: [...current.burnedNonceHashes, schemas.burnNonce(requested)],
      }));
      if (!cas?.ok) return { ok: false, reason: cas?.reason ?? "cas-failed" };
      const persisted = persistDecision(requested);
      return persisted.ok ? { ok: true } : persisted;
    }

    const changed = casDecision(proposal, requested);
    if (!changed.ok) return changed;
    if (requested.newState !== "approved") return { ok: true, auditId: changed.auditEvent?.id };
    const applied = await runApprovalFlow({ proposalId: proposal.id, actor: actor ?? requested.actor, projectFingerprint: proposal.projectFingerprint });
    const applyAudit = applied.auditEvents?.findLast?.((event) => event.kind === "apply" && event.details?.["readback-verified"] === true);
    return applied.result === "applied"
      ? { ok: true, appliedHash: applyAudit?.details?.appliedHash ?? /appliedHash ([a-f0-9]{64})/u.exec(applied.responseText ?? "")?.[1], auditId: applyAudit?.id, responseText: applied.responseText }
      : { ok: false, reason: applied.reason ?? "apply-failed", responseText: applied.responseText };
  }

  async function handleCommand(input, output) {
    const raw = typeof input === "string" ? input : input?.command ?? input?.input ?? input;
    const parsed = typeof raw === "object" && raw?.verb ? { ok: true, command: raw } : commands?.parseSelfEvolveCommand?.(raw) ?? { ok: false, error: "command-parser-unavailable" };
    if (!parsed.ok) return { ok: false, responseText: parsed.error };
    const command = parsed.command;
    let result;
    if (command.verb === "approve" || command.verb === "reject" || command.verb === "dismiss" || command.verb === "undo") {
      const proposal = currentProposal(command.proposalId);
      if (!proposal) result = { ok: false, reason: "record-not-found", responseText: `Proposal ${command.proposalId} was not found.` };
      else {
        const state = command.verb === "approve" ? "approved" : command.verb === "undo" ? "rolled-back" : "rejected";
        result = await decide({ proposalId: proposal.id, decision: makeDecision(proposal, state, "self-evolve-command"), actor: "self-evolve-command" });
      }
    } else if (command.verb === "scan") {
      result = await runEvolutionCycle({ ...(typeof input === "object" ? input : {}), trigger: "manual-command" });
    } else {
      result = commandPolicy.execute(command, { projectFingerprint: input?.projectFingerprint ?? settings()?.repo?.projectFingerprint });
      syncSchedulerMode(input?.projectFingerprint, `command-${command.verb}`);
    }
    if (output && typeof output === "object") output.responseText = result.responseText;
    return result;
  }

  function setMode(mode, opts = {}) {
    const current = settings();
    if (!current) return { ok: false, reason: "corrupt-settings" };
    if (mode === "yolo" && (!opts.confirmed || !(opts.allowlist ?? current.global.allowedSkillRoots).length)) return { ok: false, reason: opts.confirmed ? "yolo-allowlist-required" : "yolo-confirmation-required" };
    let global = current.global;
    if (mode === "yolo" && opts.allowlist) global = schemas.makeGlobalSettings({ ...global, allowedSkillRoots: opts.allowlist, updatedAt: now() });
    const request = { scope: opts.scope === "repo" ? "repo" : "global", mode, overrides: modeOverrides(current, current.repo.projectFingerprint) };
    const transitioned = schemas.transitionMode(global, current.repo, request, now(), opts.actor ?? "self-evolve-integration");
    if (!transitioned.ok) return { ok: false, reason: transitioned.error };
    const saved = request.scope === "repo" ? store.setRepoSettings(transitioned.state.repo) : store.setGlobalSettings(transitioned.state.global);
    if (saved?.ok === false) return { ok: false, reason: saved.reason };
    for (const event of transitioned.events) store.appendRecord(schemas.wrapRecord("audit-event", event, event.timestamp));
    const effectiveMode = syncSchedulerMode(current.repo.projectFingerprint, "mode-change");
    if (effectiveMode === "manual") {
      for (const item of inFlight.values()) {
        schedulerInstance.cancelPending?.(item.sessionID);
        schedulerInstance.recordWorkResult?.(item, { result: "downgrade", downgrade: true });
        downgraded.add(item.key);
      }
    }
    publish("self-evolve.settings", { action: "mode", mode, effectiveMode });
    return { ok: true, mode, effectiveMode, auditEvent: transitioned.events[0] };
  }

  function getHealth() {
    const current = settings();
    return {
      mode: resolveEffectiveMode(current?.repo?.projectFingerprint),
      repoMode: current?.repo?.mode ?? "inherit",
      circuitBreakerOpen: circuitBreakerOpen(),
      killSwitchActive: runtimeKillSwitch || current?.global?.killSwitchActive === true,
      hostVersion,
      schemaVersion: schemas.SCHEMA_VERSION,
      ...(lastError ? { lastError } : {}),
    };
  }

  function triggerKillSwitch(reason = "runtime") {
    const current = settings();
    if (!current) return { ok: false, reason: "corrupt-settings" };
    const downgrade = schemas.downgradeOnKillSwitch({
      storedMode: current.global.mode,
      effectiveMode: resolveEffectiveMode(current.repo.projectFingerprint),
      yoloApplicationEnabled: current.global.mode === "yolo",
      killSwitchActive: runtimeKillSwitch || current.global.killSwitchActive,
      actor: "self-evolve-integration",
      timestamp: now(),
    });
    if (!downgrade.ok) return { ok: false, reason: downgrade.error };
    runtimeKillSwitch = true;
    const saved = store.setGlobalSettings(schemas.makeGlobalSettings({ ...current.global, killSwitchActive: true, updatedAt: now() }));
    if (saved?.ok === false) return { ok: false, reason: saved.reason };
    for (const event of downgrade.events) store.appendRecord(schemas.wrapRecord("audit-event", event, event.timestamp));
    setModeForDowngrade("kill-switch");
    publish("self-evolve.settings", { action: "kill-switch", enabled: true });
    return { ok: true, storedMode: current.global.mode, effectiveMode: "manual", auditEvent: downgrade.events[0] };
  }

  function setModeForDowngrade(reason) {
    schedulerInstance.setMode?.("manual", reason);
    for (const item of inFlight.values()) {
      schedulerInstance.cancelPending?.(item.sessionID);
      schedulerInstance.recordWorkResult?.(item, { result: "downgrade", downgrade: true });
      downgraded.add(item.key);
    }
  }

  function clearKillSwitch(reason = "runtime") {
    const current = settings();
    if (!current) return { ok: false, reason: "corrupt-settings" };
    runtimeKillSwitch = false;
    const saved = store.setGlobalSettings(schemas.makeGlobalSettings({ ...current.global, killSwitchActive: false, updatedAt: now() }));
    if (saved?.ok === false) return { ok: false, reason: saved.reason };
    const effectiveMode = syncSchedulerMode(current.repo.projectFingerprint, "kill-switch-cleared");
    const auditEvent = appendAudit("kill-switch", { action: "off", reason: String(reason), storedMode: current.global.mode, effectiveMode });
    publish("self-evolve.settings", { action: "kill-switch", enabled: false, effectiveMode });
    return { ok: true, storedMode: current.global.mode, effectiveMode, auditEvent };
  }

  async function boot(args = {}) {
    ctx = args.ctx ?? ctx;
    hostVersion = String(args.hostVersion ?? hostVersion);
    let recovery = [];
    let hiddenSessionRecovery = [];
    try {
      settings();
      const cleanup = store.cleanupExpiredLeases?.({ actor: "self-evolve-integration", now: now() });
      if (cleanup?.then) await cleanup;
      recovery = await applier.recoverPending?.() ?? [];
      hiddenSessionRecovery = await recoverOrphanedAnalyzerSessions(ctx?.client, ctx?.directory);
      appendAudit("decision", { action: "boot", hostVersion, schemaVersion: schemas.SCHEMA_VERSION, recovered: recovery.length, abortedHiddenSessions: hiddenSessionRecovery.filter((item) => item.ok).length, hiddenSessionRecoveryFailures: hiddenSessionRecovery.filter((item) => !item.ok).length });
    } catch (error) {
      corrupt = true;
      lastError = errorReason(error);
    }
    const mode = syncSchedulerMode(settings()?.repo?.projectFingerprint, "boot");
    return { ok: !corrupt && recovery.every((item) => item.ok !== false) && hiddenSessionRecovery.every((item) => item.ok), mode, recovered: recovery, hiddenSessionRecovery, health: getHealth() };
  }

  async function shutdown() {
    if (closed) return;
    closed = true;
    schedulerInstance.dispose?.();
    applier.close?.();
    synthesisModule?.disposeSynthesis?.();
    await store.flushAudit?.();
    store.close?.();
  }

  const tuiBridge = Object.freeze({
    getInbox({ projectFingerprint } = {}) {
      const expected = projectFingerprint ?? settings()?.repo?.projectFingerprint;
      return [...latestById(store.readRecords?.("proposal") ?? []).values()]
        .filter((proposal) => proposal.projectFingerprint === expected && proposal.state === "pending")
        .map((proposal) => ({ ...proposal, eligibility: eligibilityFor(proposal) }));
    },
    getProposal({ proposalId, projectFingerprint } = {}) {
      const proposal = currentProposal(proposalId);
      if (!proposal || (projectFingerprint && proposal.projectFingerprint !== projectFingerprint)) return null;
      const content = proposalContent(proposal);
      const scan = privacy?.scanForForbiddenContent?.(content);
      const preview = scan?.ok === false ? "[preview withheld: unsafe content]" : content.split(/\r?\n/u).slice(0, 50).join("\n");
      return { proposal, eligibility: eligibilityFor(proposal), diffPreview: preview };
    },
    decide,
    execute({ command, args, projectFingerprint } = {}) {
      const value = typeof command === "object" ? { ...command, ...(args ?? {}) } : [command, ...(Array.isArray(args) ? args : [])].filter(Boolean).join(" ");
      return handleCommand({ command: value, projectFingerprint });
    },
    getHealth,
    getMode: () => ({ storedMode: settings()?.global?.mode ?? "manual", effectiveMode: resolveEffectiveMode(settings()?.repo?.projectFingerprint) }),
    setMode,
    getConsent: () => commandPolicy.getConsent?.() ?? settings()?.global?.consent,
    setConsent: (key, value) => commandPolicy.setConsent?.(key, value) ?? { ok: false, reason: "consent-policy-unavailable" },
  });

  return Object.freeze({
    handleEvent,
    handleCommand,
    runEvolutionCycle,
    runApprovalFlow,
    runRollbackFlow,
    tuiBridge,
    boot,
    shutdown,
    triggerKillSwitch,
    clearKillSwitch,
    getInFlightWork: () => [...inFlight.values()].map((item) => ({ ...item })),
  });
}
