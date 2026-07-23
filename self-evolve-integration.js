import { createHash, randomBytes } from "node:crypto";
import {
  BRIDGE_ACTOR,
  BRIDGE_TTL_MS,
  cleanupBridge,
  consumeDecisionRequests,
  publishControlState,
} from "./self-evolve-bridge.js";
import { isDurableLifecycleEvent } from "./self-evolve-core.js";
import { stateRootIdentity } from "./self-evolve-state-root.js";
import { boundedHostCall, cleanupSession, listSessions } from "./self-evolve-client.js";

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
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROUTING_SETTINGS_TTL_MS = 250;

export const ROLLOUT_GATES = DEFAULT_ROLLOUT_GATES;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function errorReason(error) {
  return String(error?.message ?? error ?? "unknown-error").split(":", 1)[0];
}

function analyzerSessionState(session) {
  return String(session?.state ?? session?.status?.type ?? session?.status ?? "").toLowerCase();
}

async function recoverOrphanedAnalyzerSessions(client, directory, { timeoutMs = 2_000, signal, maxSessions = 32 } = {}) {
  const ctx = { client, directory };
  const candidates = (await listSessions(ctx, { timeoutMs, signal, label: "session-list" })).filter((session) => {
    const agent = session?.agent ?? session?.mode ?? session?.info?.agent;
    const state = analyzerSessionState(session);
    return HIDDEN_ANALYZER_AGENTS.has(agent) && state && !TERMINAL_SESSION_STATES.has(state);
  }).slice(0, maxSessions);
  const outcomes = [];
  for (const session of candidates) {
    const id = session?.id ?? session?.sessionID;
    if (!id) continue;
    try {
      await cleanupSession(ctx, id, { timeoutMs, signal, label: "session-abort" });
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
  let hostVersionSource = options.hostVersionSource === "tui-app-version" ? "tui-app-version" : "global-health";
  let ctx = options.ctx;
  let closed = false;
  let shutdownDegraded = false;
  let terminalPurge = false;
  let mailboxTimer;
  let mailboxPolling = false;
  let mailboxPending = false;
  let mailboxTask;
  let hostRecoveryTask;
  let hostRecoveryReport;
  let hostRecoveryController;
  let retentionTimer;
  let retentionTask;
  let controlProjectionKey;
  let controlProjection;
  let controlProjectionRefreshAt = 0;
  let routingSettingsSnapshot;
  let routingSettingsRefreshAt = 0;
  const setRetentionInterval = options.__testSetInterval ?? setInterval;
  const clearRetentionInterval = options.__testClearInterval ?? clearInterval;
  const retentionIntervalMs = options.__testRetentionIntervalMs ?? RETENTION_INTERVAL_MS;
  const retainStore = options.__testRunStoreRetention ?? ((timestamp) => store.retain(timestamp));
  const setMailboxInterval = options.__testSetMailboxInterval ?? setInterval;
  const clearMailboxInterval = options.__testClearMailboxInterval ?? clearInterval;
  const consumeMailbox = options.__testConsumeDecisionRequests ?? consumeDecisionRequests;
  const routingSettingsTtlMs = options.__testRoutingSettingsTtlMs ?? ROUTING_SETTINGS_TTL_MS;

  function invalidateRoutingSettings() {
    routingSettingsSnapshot = undefined;
    routingSettingsRefreshAt = 0;
  }

  function settings({ routing = false } = {}) {
    if (terminalPurge || store.isTerminal?.()) return null;
    const timestamp = routing ? now() : 0;
    if (routing && routingSettingsSnapshot && timestamp < routingSettingsRefreshAt) return routingSettingsSnapshot;
    try {
      const value = store.getSettings();
      if (!value?.global || !value?.repo) throw new Error("corrupt-settings");
      if (routing) {
        routingSettingsSnapshot = value;
        routingSettingsRefreshAt = timestamp + routingSettingsTtlMs;
      }
      return value;
    } catch (error) {
      invalidateRoutingSettings();
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

  function resolveEffectiveMode(projectFingerprint, current = settings()) {
    const mode = schemas.resolveMode(current?.global?.mode ?? "manual", current?.repo?.mode ?? "inherit", modeOverrides(current, projectFingerprint));
    return schemas.Mode?.values?.includes(mode) ? mode : "manual";
  }

  function rolloutMetrics() {
    const records = store.readRecords?.("audit-event") ?? [];
    const projectFingerprint = settings()?.repo?.projectFingerprint;
    const outcomes = new Map();
    for (const record of records) {
      const outcome = schemas.parseSynthesisOutcomeAuditEvent?.(record.payload);
      if (!outcome || outcome.projectFingerprint !== projectFingerprint || outcomes.has(outcome.outcomeId)) continue;
      outcomes.set(outcome.outcomeId, outcome);
    }
    const values = [...outcomes.values()];
    const successes = values.filter((outcome) => outcome.success).length;
    return { synthesesObserved: values.length, successRate: values.length ? successes / values.length : 0 };
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
      let proposal = args.proposal;
      let decision = args.decision;
      if (args.mode === "yolo" && proposal?.state === "pending" && currentProposal(proposal.id)) {
        const preliminary = evaluateAuthority({ ...args, proposal, decision });
        if (!preliminary.allowed) return { ok: false, reason: preliminary.reason };
        decision = makeDecision(proposal, "approved", "self-evolve-applier");
        const changed = casDecision(proposal, decision);
        if (!changed.ok) return { ok: false, reason: changed.reason };
        proposal = { ...changed.proposal, ...(proposal.proposedContent === undefined ? {} : { proposedContent: proposal.proposedContent }) };
      }
      const authority = evaluateAuthority({ ...args, proposal, decision });
      if (!authority.allowed) return { ok: false, reason: authority.reason };
      return applier.applyProposal({ ...args, proposal, decision });
    },
  });

  const commandPolicy = instantiate(commands, "createCommandPolicy", {
    store,
    privacy,
    schemaVersion: schemas.SCHEMA_VERSION,
    hostVersion,
    hostVersionSource,
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
      result = await runEvolutionCycle({
        ...workItem,
        ctx,
        trigger: workItem.trigger ?? "scheduler",
        options: {
          ...(workItem.options ?? {}),
          reservePassiveProviderCalls: (count, context) => schedulerInstance.reservePassiveProviderCalls(count, {
            ...context,
            rootSessionIDHash: workItem.rootSessionIDHash,
          }),
        },
      });
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

  function syncSchedulerMode(projectFingerprint, reason = "settings-refresh", current) {
    const mode = resolveEffectiveMode(projectFingerprint, current);
    schedulerInstance.setMode?.(mode, reason);
    return mode;
  }

  function currentProposal(proposalId) {
    return latestById(store.readRecords?.("proposal") ?? []).get(proposalId) ?? null;
  }

  function actionableProposals() {
    return [...latestById(store.readRecords?.("proposal") ?? []).values()]
      .filter((proposal) => proposal.projectFingerprint === settings()?.repo?.projectFingerprint && ["pending", "applied"].includes(proposal.state));
  }

  function latestBridgeGrant(proposalId) {
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.proposalId === proposalId && event.details?.action === "bridge-nonce");
  }

  function latestHeadlessGrant(proposalId) {
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.proposalId === proposalId && event.details?.action === "headless-approval-nonce");
  }

  function issueBridgeNonces() {
    if (!options.stateRoot) return [];
    const issued = [];
    for (const proposal of actionableProposals()) {
      const existing = latestBridgeGrant(proposal.id)?.details;
      const timestamp = now();
      if (!(existing
        && existing.expiresAt > timestamp
        && existing.targetHash === proposal.skillTarget.currentHash
        && existing.proposedContentHash === proposal.proposedContentHash
        && existing.decisionVersion === proposal.decisionVersion + 1
        && existing.priorState === proposal.state
        && existing.actor === BRIDGE_ACTOR)) {
        appendAudit("decision", {
          action: "bridge-nonce",
          projectFingerprint: proposal.projectFingerprint,
          subjectId: proposal.id,
          targetHash: proposal.skillTarget.currentHash,
          proposedContentHash: proposal.proposedContentHash,
          decisionVersion: proposal.decisionVersion + 1,
          priorState: proposal.state,
          actor: BRIDGE_ACTOR,
          nonce: randomBytes(24).toString("hex"),
          expiresAt: timestamp + BRIDGE_TTL_MS,
        }, proposal.id);
      }
      const headless = latestHeadlessGrant(proposal.id)?.details;
      if (!headless
        || headless.expiresAt <= timestamp
        || headless.targetHash !== proposal.skillTarget.currentHash
        || headless.proposedContentHash !== proposal.proposedContentHash
        || headless.decisionVersion !== proposal.decisionVersion + 1
        || headless.priorState !== proposal.state) {
        appendAudit("decision", {
          action: "headless-approval-nonce",
          projectFingerprint: proposal.projectFingerprint,
          subjectId: proposal.id,
          targetHash: proposal.skillTarget.currentHash,
          proposedContentHash: proposal.proposedContentHash,
          decisionVersion: proposal.decisionVersion + 1,
          priorState: proposal.state,
          actor: "self-evolve-command",
          nonce: randomBytes(24).toString("hex"),
          expiresAt: timestamp + BRIDGE_TTL_MS,
        }, proposal.id);
      }
      issued.push(proposal.id);
    }
    return issued;
  }

  function settingsVersion(current) {
    return sha256(JSON.stringify({ global: current.global, repo: current.repo }));
  }

  function latestControlGrant() {
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.details?.action === "control-nonce");
  }

  function completedControlRequest(request) {
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.details?.action === "control-request-complete"
      && event.details?.requestId === request.requestId);
  }

  function completedControlNonce(nonce) {
    const nonceHash = sha256(nonce);
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.details?.action === "control-request-complete"
      && event.details?.nonceHash === nonceHash);
  }

  function issueControlGrant() {
    if (!options.stateRoot) return null;
    const current = settings();
    if (!current) return null;
    const version = settingsVersion(current);
    const timestamp = now();
    let grant = latestControlGrant()?.details;
    if (!grant
      || grant.projectFingerprint !== current.repo.projectFingerprint
      || grant.actor !== BRIDGE_ACTOR
      || grant.settingsUpdatedAt !== current.global.updatedAt
      || grant.settingsVersion !== version
      || grant.expiresAt <= timestamp
      || completedControlNonce(grant.nonce)) {
      const nonce = randomBytes(24).toString("hex");
      appendAudit("decision", {
        action: "control-nonce",
        projectFingerprint: current.repo.projectFingerprint,
        actor: BRIDGE_ACTOR,
        nonce,
        settingsUpdatedAt: current.global.updatedAt,
        settingsVersion: version,
        expiresAt: timestamp + BRIDGE_TTL_MS,
      });
      grant = latestControlGrant()?.details;
    }
    if (!grant) return null;
    const projection = {
      schemaVersion: schemas.SCHEMA_VERSION,
      projectFingerprint: current.repo.projectFingerprint,
      actor: "self-evolve-integration",
      issuedAt: timestamp,
      expiresAt: grant.expiresAt,
      settingsUpdatedAt: current.global.updatedAt,
      settingsVersion: version,
      stateRootIdentity: stateRootIdentity(options.stateRoot),
      nonce: grant.nonce,
      mode: current.global.mode,
      effectiveMode: resolveEffectiveMode(current.repo.projectFingerprint),
      allowedSkillRoots: current.global.allowedSkillRoots,
      consent: current.global.consent,
      repoExcluded: current.repo.excluded,
    };
    const projectionKey = sha256(JSON.stringify({ ...projection, issuedAt: 0 }));
    if (controlProjectionKey === projectionKey && controlProjection && timestamp < controlProjectionRefreshAt) return controlProjection;
    controlProjection = publishControlState(options.stateRoot, projection);
    controlProjectionKey = projectionKey;
    controlProjectionRefreshAt = Math.min(grant.expiresAt, timestamp + 60_000);
    return controlProjection;
  }

  function completedBridgeRequest(request) {
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.proposalId === request.proposalId
      && event.details?.action === "bridge-request-complete"
      && event.details?.requestId === request.requestId);
  }

  function completedBridgeNonce(request) {
    const nonceHash = sha256(request.nonce);
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.proposalId === request.proposalId
      && event.details?.action === "bridge-request-complete"
      && event.details?.nonceHash === nonceHash);
  }

  function matchingStoredDecision(request) {
    return (store.readRecords?.("decision") ?? []).map((record) => record.payload).findLast((decision) =>
      decision.proposalId === request.proposalId
      && decision.targetHash === request.targetHash
      && decision.proposedContentHash === request.proposedContentHash
      && decision.decisionVersion === request.decisionVersion
      && decision.actor === request.actor
      && decision.timestamp === request.timestamp
      && decision.nonce === request.nonce
      && decision.priorState === request.priorState
      && decision.newState === request.newState);
  }

  function recordBridgeCompletion(request, result, recovered = false) {
    return appendAudit("decision", {
      action: "bridge-request-complete",
      requestId: request.requestId,
      nonceHash: sha256(request.nonce),
      accepted: result.ok === true,
      reason: result.ok === true ? "accepted" : String(result.reason ?? "decision-rejected"),
      recovered,
    }, request.proposalId, "self-evolve-integration");
  }

  function recordControlCompletion(request, result) {
    return appendAudit("decision", {
      action: "control-request-complete",
      requestId: request.requestId,
      nonceHash: sha256(request.nonce),
      controlAction: request.action,
      accepted: result.ok === true,
      reason: result.ok === true ? "accepted" : String(result.reason ?? "control-rejected"),
    }, undefined, "self-evolve-integration");
  }

  function validateMailboxControl(request) {
    if (completedControlRequest(request)) return { ok: false, reason: "replayed-request" };
    if (completedControlNonce(request.nonce)) return { ok: false, reason: "replayed-control" };
    const fresh = settings();
    if (!fresh) return { ok: false, reason: "corrupt-settings" };
    const grant = latestControlGrant()?.details;
    const version = settingsVersion(fresh);
    let result;
    if (request.projectFingerprint !== fresh.repo.projectFingerprint) result = { ok: false, reason: "cross-project-request" };
    else if (!grant
      || grant.action !== "control-nonce"
      || grant.projectFingerprint !== request.projectFingerprint
      || grant.actor !== request.actor
      || grant.nonce !== request.nonce
      || grant.settingsUpdatedAt !== request.settingsUpdatedAt
      || grant.settingsVersion !== request.settingsVersion
      || grant.expiresAt <= now()) result = { ok: false, reason: "invalid-or-expired-nonce" };
    else if (request.settingsUpdatedAt !== fresh.global.updatedAt || request.settingsVersion !== version) result = { ok: false, reason: "stale-settings-version" };
    if (result) {
      recordControlCompletion(request, result);
      return result;
    }

    let transitionEvents = [];
    const saved = store.updateSettings((current) => {
      if (current.global.updatedAt !== request.settingsUpdatedAt || settingsVersion(current) !== request.settingsVersion) throw new Error("stale-settings-version");
      if (request.action === "set-mode") {
        let global = current.global;
        if (request.payload.mode === "yolo") {
          if (request.payload.confirmation !== "ENABLE YOLO" || request.payload.allowlist.length === 0) throw new Error("yolo-confirmation-required");
          global = schemas.makeGlobalSettings({ ...global, allowedSkillRoots: request.payload.allowlist, updatedAt: now() });
        }
        const transitioned = schemas.transitionMode(global, current.repo, {
          scope: "global",
          mode: request.payload.mode,
          overrides: modeOverrides(current, current.repo.projectFingerprint),
        }, now(), BRIDGE_ACTOR);
        if (!transitioned.ok) throw new Error(transitioned.error);
        transitionEvents = transitioned.events;
        return { global: transitioned.state.global };
      }
      if (request.action === "set-consent") {
        const consent = schemas.makeConsentState({ ...current.global.consent, [request.payload.key]: request.payload.enabled });
        if (consent.crossRepoAggregation && !consent.sanitizedExcerpts) throw new Error("sanitized-excerpts-consent-required");
        return { global: schemas.makeGlobalSettings({ ...current.global, consent, updatedAt: now() }) };
      }
      if (request.action === "set-repo-excluded") {
        return { repo: schemas.makeRepoSettings({ ...current.repo, excluded: request.payload.excluded }) };
      }
      if (request.action === "update-allowlist") {
        if (request.payload.confirmation !== "UPDATE ALLOWLIST") throw new Error("allowlist-confirmation-required");
        return { global: schemas.makeGlobalSettings({ ...current.global, allowedSkillRoots: request.payload.allowlist, updatedAt: now() }) };
      }
      throw new Error("unknown-control-action");
    }, { expectedGlobalUpdatedAt: request.settingsUpdatedAt });
    result = saved.ok ? { ok: true } : { ok: false, reason: saved.reason ?? "control-rejected" };
    if (saved.ok) {
      invalidateRoutingSettings();
      for (const event of transitionEvents) store.appendRecord(schemas.wrapRecord("audit-event", event, event.timestamp));
      const effectiveMode = syncSchedulerMode(request.projectFingerprint, `control-${request.action}`);
      publish("self-evolve.settings", { action: request.action, effectiveMode });
    }
    recordControlCompletion(request, result);
    return result;
  }

  async function validateMailboxDecision(request) {
    if (completedBridgeRequest(request)) return { ok: false, reason: "replayed-request" };
    if (completedBridgeNonce(request)) return { ok: false, reason: "replayed-decision" };
    const stored = matchingStoredDecision(request);
    if (stored) {
      const proposal = currentProposal(request.proposalId);
      if (request.newState === "approved" && proposal?.state === "approved") {
        const applied = await runApprovalFlow({ proposalId: proposal.id, actor: request.actor, projectFingerprint: proposal.projectFingerprint });
        if (applied.result !== "applied") {
          const result = { ok: false, reason: applied.reason ?? "apply-recovery-failed" };
          recordBridgeCompletion(request, result, true);
          return { ...result, recovered: true };
        }
        markApplied(proposal.id);
      }
      const recoveredProposal = currentProposal(request.proposalId);
      const expectedState = request.newState === "approved" ? "applied" : request.newState;
      if (recoveredProposal?.state !== expectedState) {
        const result = { ok: false, reason: "incomplete-decision-recovery" };
        recordBridgeCompletion(request, result, true);
        return { ...result, recovered: true };
      }
      recordBridgeCompletion(request, { ok: true }, true);
      return { ok: true, recovered: true };
    }
    const current = settings();
    const proposal = currentProposal(request.proposalId);
    if (!current || !proposal) return { ok: false, reason: "record-not-found" };
    if (request.projectFingerprint !== current.repo.projectFingerprint || proposal.projectFingerprint !== current.repo.projectFingerprint) return { ok: false, reason: "cross-project-request" };
    const grant = latestBridgeGrant(proposal.id)?.details;
    if (!grant
      || grant.action !== "bridge-nonce"
      || grant.projectFingerprint !== request.projectFingerprint
      || grant.subjectId !== request.proposalId
      || grant.targetHash !== request.targetHash
      || grant.proposedContentHash !== request.proposedContentHash
      || grant.decisionVersion !== request.decisionVersion
      || grant.priorState !== request.priorState
      || grant.actor !== request.actor
      || grant.nonce !== request.nonce
      || grant.expiresAt <= now()) return { ok: false, reason: "invalid-or-expired-nonce" };
    if (proposal.skillTarget.currentHash !== request.targetHash || proposal.proposedContentHash !== request.proposedContentHash) return { ok: false, reason: "hash-binding-mismatch" };
    if (proposal.decisionVersion + 1 !== request.decisionVersion) return { ok: false, reason: "stale-decision-version" };
    if (proposal.state !== request.priorState) return { ok: false, reason: "stale-prior-state" };
    const transitionAllowed = (request.priorState === "pending" && ["approved", "rejected", "pending"].includes(request.newState))
      || (request.priorState === "applied" && request.newState === "rolled-back");
    if (!transitionAllowed) return { ok: false, reason: "invalid-transition" };
    if (request.newState === "approved" && resolveEffectiveMode(request.projectFingerprint) === "manual") return { ok: false, reason: "manual-advisory-only" };
    const result = await decide({
      proposalId: proposal.id,
      actor: request.actor,
      decision: schemas.makeDecision({
        proposalId: request.proposalId,
        targetHash: request.targetHash,
        proposedContentHash: request.proposedContentHash,
        decisionVersion: request.decisionVersion,
        actor: request.actor,
        timestamp: request.timestamp,
        nonce: request.nonce,
        priorState: request.priorState,
        newState: request.newState,
      }),
    });
    recordBridgeCompletion(request, result);
    return result;
  }

  async function runMailboxPass() {
    try {
      issueBridgeNonces();
      let controlStateError;
      try { issueControlGrant(); } catch (error) { controlStateError = errorReason(error); lastError = controlStateError; }
      const projectFingerprint = settings()?.repo?.projectFingerprint;
      if (!projectFingerprint) return { ok: false, reason: "corrupt-settings", processed: [] };
      const consumed = await consumeMailbox({
        stateRoot: options.stateRoot,
        projectFingerprint,
        now,
        validateAndDecide: validateMailboxDecision,
        validateAndControl: validateMailboxControl,
        maxRequests: options.mailboxMaxRequests,
      });
      try { issueControlGrant(); } catch (error) { controlStateError = errorReason(error); lastError = controlStateError; }
      return controlStateError ? { ...consumed, controlStateError } : consumed;
    } catch (error) {
      lastError = errorReason(error);
      return { ok: false, reason: lastError, processed: [] };
    }
  }

  async function processMailbox() {
    if (!options.stateRoot || closed || terminalPurge) return { ok: false, reason: terminalPurge ? "restart-required-after-purge-all" : closed ? "integration-closed" : "mailbox-unavailable", processed: [] };
    if (mailboxPolling) {
      mailboxPending = true;
      return mailboxTask;
    }
    mailboxPolling = true;
    mailboxTask = (async () => {
      let result;
      do {
        mailboxPending = false;
        result = await runMailboxPass();
      } while (mailboxPending && !closed && !terminalPurge);
      return result;
    })();
    try {
      return await mailboxTask;
    } finally {
      mailboxPolling = false;
      mailboxPending = false;
      mailboxTask = undefined;
    }
  }

  function startMailboxPolling() {
    if (!options.stateRoot || mailboxTimer || closed || terminalPurge) return;
    const intervalMs = Math.min(60_000, Math.max(25, Number.isFinite(options.mailboxPollMs) ? options.mailboxPollMs : 500));
    mailboxTimer = setMailboxInterval(() => { void processMailbox(); }, intervalMs);
    mailboxTimer.unref?.();
  }

  function runRetentionSweep() {
    if (terminalPurge) return Promise.resolve({ ok: false, reason: "restart-required-after-purge-all" });
    if (closed) return Promise.resolve({ ok: false, reason: "integration-closed" });
    if (retentionTask) return retentionTask;
    retentionTask = Promise.resolve().then(async () => {
      const timestamp = now();
      const records = await retainStore(timestamp);
      let bridge = { ok: true, removed: 0 };
      const projectFingerprint = settings()?.repo?.projectFingerprint;
      if (options.stateRoot && projectFingerprint) bridge = cleanupBridge(options.stateRoot, projectFingerprint, { now: timestamp });
      return { ok: true, records, bridge, sweptAt: timestamp };
    }).catch((error) => {
      lastError = errorReason(error);
      return { ok: false, reason: lastError };
    }).finally(() => {
      retentionTask = undefined;
    });
    return retentionTask;
  }

  function startRetentionTimer() {
    if (retentionTimer || closed || terminalPurge) return;
    retentionTimer = setRetentionInterval(() => { void runRetentionSweep(); }, retentionIntervalMs);
    retentionTimer?.unref?.();
  }

  function proposalContent(proposal) {
    if (typeof proposal?.proposedContent === "string") return proposal.proposedContent;
    return pipelineInstance.readProposalContent?.(proposal) ?? "";
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

  function casDecision(proposal, decision) {
    const committed = store.commitDecision(decision);
    return committed?.ok ? { ok: true, proposal: committed.proposal } : { ok: false, reason: committed?.reason ?? "decision-transaction-failed" };
  }

  function markApplied(proposalId) {
    const proposal = currentProposal(proposalId);
    if (!proposal || proposal.state !== "approved") return;
    const decision = makeDecision(proposal, "applied", "self-evolve-applier");
    return casDecision(proposal, decision);
  }

  function markFailedClosed(proposalId, reason, actor = "self-evolve-integration") {
    const proposal = currentProposal(proposalId);
    if (!proposal || proposal.state === "failed-closed") return { ok: proposal?.state === "failed-closed", proposal };
    if (!["pending", "approved", "applied"].includes(proposal.state)) return { ok: false, reason: "invalid-failed-closed-prior-state" };
    const boundedReason = String(reason ?? "apply-failed").slice(0, 400);
    const changed = casDecision(proposal, makeDecision(proposal, "failed-closed", actor));
    if (changed.ok) appendAudit("apply", { state: "critical", reason: boundedReason, "readback-verified": false, applyAuthority: false }, proposal.id, actor);
    return changed;
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
      const finalized = currentProposal(result.proposal?.id) ? markApplied(result.proposal?.id) : { ok: true };
      if (!finalized?.ok) return { result: "failed-closed", reason: finalized?.reason ?? "applied-transition-failed", responseText: `Proposal ${result.proposal?.id} was applied but final state recovery is required.` };
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
    const result = await pipelineInstance.runApprovalFlow({ ...args, ctx: args.ctx ?? ctx, mode, projectFingerprint: args.projectFingerprint ?? proposal.projectFingerprint, headless: args.headless === true });
    if (result?.result === "applied") {
      const finalized = markApplied(proposal.id);
      if (!finalized?.ok) return { result: "failed-closed", reason: finalized?.reason ?? "applied-transition-failed", responseText: `Proposal ${proposal.id} was applied but final state recovery is required.` };
      return { ...result, responseText: `${result.responseText}\n${RESTART_REMINDER}` };
    }
    if (result?.deferred || result?.reason === "lease-busy") return { ...result, result: "deferred", deferred: true };
    if (currentProposal(proposal.id)?.state === "approved") markFailedClosed(proposal.id, result?.reason ?? "apply-failed");
    return result;
  }

  async function runRollbackFlow(args = {}) {
    return pipelineInstance.runRollbackFlow({ ...args, ctx: args.ctx ?? ctx });
  }

  async function handleEvent(event) {
    if (terminalPurge) return { scheduled: false, reason: "restart-required-after-purge-all" };
    if (!isDurableLifecycleEvent(event)) return { scheduled: false, reason: "irrelevant-event" };
    const current = settings({ routing: true });
    const body = event?.event && typeof event.event === "object" ? event.event : event;
    const projectFingerprint = body?.properties?.projectFingerprint ?? current?.repo?.projectFingerprint;
    const mode = syncSchedulerMode(projectFingerprint, "event-refresh", current);
    if (mode === "manual") {
      invalidateRoutingSettings();
      return { scheduled: false, reason: "manual-mode" };
    }
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
      if (rolledBack.result !== "rolled-back") {
        markFailedClosed(proposal.id, rolledBack.reason ?? "rollback-failed");
        return { ok: false, reason: rolledBack.reason ?? "rollback-failed" };
      }
      proposal = currentProposal(id);
      const internal = makeDecision(proposal, "rolled-back", "self-evolve-applier");
      const changed = casDecision(proposal, internal);
      return changed.ok ? { ok: true, auditId: rolledBack.auditEvents?.at(-1)?.id } : changed;
    }

    if (requested.newState === "pending") {
      if (proposal.state !== requested.priorState || proposal.state !== "pending") return { ok: false, reason: "stale-prior-state" };
      const committed = casDecision(proposal, requested);
      if (!committed.ok) return committed;
      appendAudit("decision", { action: "snooze", snoozedUntil: requested.timestamp + 86_400_000, state: "pending" }, proposal.id, requested.actor);
      return { ok: true };
    }

    const changed = casDecision(proposal, requested);
    if (!changed.ok) return changed;
    if (requested.newState !== "approved") return { ok: true, auditId: changed.auditEvent?.id };
    const applied = await runApprovalFlow({ proposalId: proposal.id, actor: actor ?? requested.actor, projectFingerprint: proposal.projectFingerprint });
    const applyAudit = applied.auditEvents?.findLast?.((event) => event.kind === "apply" && event.details?.["readback-verified"] === true);
    if (applied.result !== "applied") markFailedClosed(proposal.id, applied.reason ?? "apply-failed");
    return applied.result === "applied"
      ? { ok: true, appliedHash: applyAudit?.details?.appliedHash ?? /appliedHash ([a-f0-9]{64})/u.exec(applied.responseText ?? "")?.[1], auditId: applyAudit?.id, responseText: applied.responseText }
      : { ok: false, reason: applied.reason ?? "apply-failed", responseText: applied.responseText };
  }

  async function approveHeadless(command) {
    const proposal = currentProposal(command.proposalId);
    const current = settings();
    const grant = latestHeadlessGrant(command.proposalId)?.details;
    if (!proposal || !current || !grant) return { ok: false, reason: "record-not-found", responseText: `Proposal ${command.proposalId} has no current headless approval grant.` };
    const effectiveMode = resolveEffectiveMode(proposal.projectFingerprint);
    if (effectiveMode !== "auto") {
      const reason = effectiveMode === "manual" ? "manual-advisory-only" : "auto-mode-required";
      return { ok: false, reason, responseText: `Proposal ${proposal.id} was not applied: ${reason}.` };
    }
    const exact = proposal.projectFingerprint === current.repo.projectFingerprint
      && proposal.state === "pending"
      && proposal.skillTarget.currentHash === command.targetHash
      && proposal.proposedContentHash === command.proposedContentHash
      && proposal.decisionVersion + 1 === command.decisionVersion
      && grant.action === "headless-approval-nonce"
      && grant.projectFingerprint === proposal.projectFingerprint
      && grant.subjectId === proposal.id
      && grant.targetHash === command.targetHash
      && grant.proposedContentHash === command.proposedContentHash
      && grant.decisionVersion === command.decisionVersion
      && grant.priorState === proposal.state
      && grant.actor === "self-evolve-command"
      && grant.nonce === command.nonce
      && grant.expiresAt > now();
    if (!exact) return { ok: false, reason: "approval-tuple-mismatch", responseText: `Proposal ${proposal.id} was not applied: approval-tuple-mismatch.` };
    const decision = schemas.makeDecision({
      proposalId: proposal.id,
      targetHash: command.targetHash,
      proposedContentHash: command.proposedContentHash,
      decisionVersion: command.decisionVersion,
      actor: "self-evolve-command",
      timestamp: now(),
      nonce: command.nonce,
      priorState: "pending",
      newState: "approved",
    });
    const changed = casDecision(proposal, decision);
    if (!changed.ok) return { ok: false, reason: changed.reason, responseText: `Proposal ${proposal.id} was not applied: ${changed.reason}.` };
    const applied = await runApprovalFlow({ proposalId: proposal.id, actor: decision.actor, projectFingerprint: proposal.projectFingerprint, headless: true });
    if (applied.result !== "applied") markFailedClosed(proposal.id, applied.reason ?? "apply-failed");
    return applied.result === "applied"
      ? { ok: true, responseText: applied.responseText, auditEvents: applied.auditEvents }
      : { ok: false, reason: applied.reason ?? "apply-failed", responseText: applied.responseText };
  }

  async function handleCommand(input, output) {
    if (closed) return { ok: false, reason: "integration-closed" };
    if (terminalPurge) {
      const result = { ok: false, terminal: true, responseText: "Self-evolve state was purged. Restart OpenCode to reinitialize durable self-evolve state." };
      if (output && typeof output === "object") output.responseText = result.responseText;
      return result;
    }
    await processMailbox();
    const raw = typeof input === "string" ? input : input?.command ?? input?.input ?? input;
    const parsed = typeof raw === "object" && raw?.verb ? { ok: true, command: raw } : commands?.parseSelfEvolveCommand?.(raw) ?? { ok: false, error: "command-parser-unavailable" };
    if (!parsed.ok) return { ok: false, responseText: parsed.error };
    const command = parsed.command;
    let result;
    if (command.verb === "approve") {
      result = await approveHeadless(command);
    } else if (command.verb === "reject" || command.verb === "dismiss" || command.verb === "undo") {
      const proposal = currentProposal(command.proposalId);
      if (!proposal) result = { ok: false, reason: "record-not-found", responseText: `Proposal ${command.proposalId} was not found.` };
      else {
        const state = command.verb === "undo" ? "rolled-back" : "rejected";
        result = await decide({ proposalId: proposal.id, decision: makeDecision(proposal, state, "self-evolve-command"), actor: "self-evolve-command" });
      }
    } else if (command.verb === "scan") {
      result = await runEvolutionCycle({ ...(typeof input === "object" ? input : {}), trigger: "manual-command" });
    } else {
      result = commandPolicy.execute(command, { projectFingerprint: input?.projectFingerprint ?? settings()?.repo?.projectFingerprint });
      if (result.terminalPurge) stopAfterPurgeAll();
      else {
        invalidateRoutingSettings();
        syncSchedulerMode(input?.projectFingerprint, `command-${command.verb}`);
      }
    }
    if (output && typeof output === "object") output.responseText = result.responseText;
    if (!terminalPurge) await processMailbox();
    return result;
  }

  function stopAfterPurgeAll() {
    terminalPurge = true;
    clearMailboxInterval(mailboxTimer);
    mailboxTimer = undefined;
    clearRetentionInterval(retentionTimer);
    retentionTimer = undefined;
    schedulerInstance.setMode?.("manual", "purge-all");
    schedulerInstance.dispose?.();
    for (const item of inFlight.values()) schedulerInstance.cancelPending?.(item.sessionID);
  }

  function setMode(mode, opts = {}) {
    if (terminalPurge) return { ok: false, reason: "restart-required-after-purge-all" };
    let transitioned;
    let projectFingerprint;
    const saved = store.updateSettings((current) => {
      if (mode === "yolo" && (!opts.confirmed || !(opts.allowlist ?? current.global.allowedSkillRoots).length)) throw new Error(opts.confirmed ? "yolo-allowlist-required" : "yolo-confirmation-required");
      let global = current.global;
      if (mode === "yolo" && opts.allowlist) global = schemas.makeGlobalSettings({ ...global, allowedSkillRoots: opts.allowlist, updatedAt: now() });
      const request = { scope: opts.scope === "repo" ? "repo" : "global", mode, overrides: modeOverrides(current, current.repo.projectFingerprint) };
      transitioned = schemas.transitionMode(global, current.repo, request, now(), opts.actor ?? "self-evolve-integration");
      if (!transitioned.ok) throw new Error(transitioned.error);
      projectFingerprint = current.repo.projectFingerprint;
      return request.scope === "repo" ? { repo: transitioned.state.repo } : { global: transitioned.state.global };
    });
    if (!saved.ok) return { ok: false, reason: saved.reason };
    invalidateRoutingSettings();
    for (const event of transitioned.events) store.appendRecord(schemas.wrapRecord("audit-event", event, event.timestamp));
    const effectiveMode = syncSchedulerMode(projectFingerprint, "mode-change");
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
    const hostSessionRecovery = hostRecoveryReport ? {
      ok: hostRecoveryReport.ok,
      cancelled: hostRecoveryReport.cancelled,
      attempts: hostRecoveryReport.attempts,
      aborted: hostRecoveryReport.aborted,
      failed: hostRecoveryReport.failed,
      ...(hostRecoveryReport.reason ? { reason: hostRecoveryReport.reason } : {}),
    } : null;
    return {
      mode: resolveEffectiveMode(current?.repo?.projectFingerprint),
      repoMode: current?.repo?.mode ?? "inherit",
      circuitBreakerOpen: circuitBreakerOpen(),
      killSwitchActive: runtimeKillSwitch || current?.global?.killSwitchActive === true,
      hostVersion,
      hostVersionSource,
      schemaVersion: schemas.SCHEMA_VERSION,
      ...(hostSessionRecovery ? { hostSessionRecovery } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  async function recoverHostSessions(args = {}) {
    if (hostRecoveryReport) return hostRecoveryReport;
    if (hostRecoveryTask) return hostRecoveryTask;
    if (closed) return { ok: false, cancelled: true, attempts: 0, outcomes: [], reason: "integration-closed" };
    const timeoutMs = Math.min(10_000, Math.max(10, args.timeoutMs ?? options.hostRecoveryTimeoutMs ?? 2_000));
    const retries = Math.min(3, Math.max(0, args.retries ?? options.hostRecoveryRetries ?? 2));
    const backoffMs = Math.min(2_000, Math.max(1, args.backoffMs ?? options.hostRecoveryBackoffMs ?? 50));
    hostRecoveryController = new AbortController();
    const { signal } = hostRecoveryController;
    hostRecoveryTask = (async () => {
      let attempts = 0;
      let outcomes = [];
      let reason;
      while (attempts <= retries && !signal.aborted) {
        attempts += 1;
        try {
          outcomes = await recoverOrphanedAnalyzerSessions(ctx?.client, ctx?.directory, { timeoutMs, signal });
          reason = undefined;
          break;
        } catch (error) {
          reason = errorReason(error);
          if (attempts > retries || signal.aborted) break;
          await boundedHostCall(
            () => new Promise((resolve) => setTimeout(resolve, backoffMs * (2 ** (attempts - 1)))),
            { timeoutMs: backoffMs * (2 ** (attempts - 1)) + 10, signal, label: "host-recovery-backoff" },
          ).catch(() => {});
        }
      }
      const report = {
        ok: !signal.aborted && reason === undefined && outcomes.every((item) => item.ok),
        cancelled: signal.aborted,
        attempts,
        aborted: outcomes.filter((item) => item.ok).length,
        failed: outcomes.filter((item) => !item.ok).length,
        outcomes,
        ...(reason ? { reason } : {}),
      };
      hostRecoveryReport = report;
      try { appendAudit("decision", { action: "host-session-recovery", attempts, aborted: report.aborted, failed: report.failed, cancelled: report.cancelled, ...(reason ? { reason } : {}) }); } catch {}
      return report;
    })().finally(() => { hostRecoveryTask = undefined; hostRecoveryController = undefined; });
    return hostRecoveryTask;
  }

  function triggerKillSwitch(reason = "runtime") {
    if (terminalPurge) return { ok: false, reason: "restart-required-after-purge-all" };
    let downgrade;
    let storedMode;
    const saved = store.updateGlobalSettings((global, current) => {
      storedMode = global.mode;
      downgrade = schemas.downgradeOnKillSwitch({
        storedMode,
        effectiveMode: schemas.resolveMode(global.mode, current.repo.mode, modeOverrides(current, current.repo.projectFingerprint)),
        yoloApplicationEnabled: global.mode === "yolo",
        killSwitchActive: runtimeKillSwitch || global.killSwitchActive,
        actor: "self-evolve-integration",
        timestamp: now(),
      });
      if (!downgrade.ok) throw new Error(downgrade.error);
      return schemas.makeGlobalSettings({ ...global, killSwitchActive: true, updatedAt: now() });
    });
    if (!saved.ok) return { ok: false, reason: saved.reason };
    runtimeKillSwitch = true;
    invalidateRoutingSettings();
    for (const event of downgrade.events) store.appendRecord(schemas.wrapRecord("audit-event", event, event.timestamp));
    setModeForDowngrade("kill-switch");
    publish("self-evolve.settings", { action: "kill-switch", enabled: true });
    return { ok: true, storedMode, effectiveMode: "manual", auditEvent: downgrade.events[0] };
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
    if (terminalPurge) return { ok: false, reason: "restart-required-after-purge-all" };
    runtimeKillSwitch = false;
    let projectFingerprint;
    const saved = store.updateGlobalSettings((global, current) => {
      projectFingerprint = current.repo.projectFingerprint;
      return schemas.makeGlobalSettings({ ...global, killSwitchActive: false, updatedAt: now() });
    });
    if (!saved.ok) return { ok: false, reason: saved.reason };
    invalidateRoutingSettings();
    const effectiveMode = syncSchedulerMode(projectFingerprint, "kill-switch-cleared");
    const auditEvent = appendAudit("kill-switch", { action: "off", reason: String(reason), storedMode: saved.settings.global.mode, effectiveMode });
    publish("self-evolve.settings", { action: "kill-switch", enabled: false, effectiveMode });
    return { ok: true, storedMode: saved.settings.global.mode, effectiveMode, auditEvent };
  }

  async function boot(args = {}) {
    if (terminalPurge) return { ok: false, mode: "manual", reason: "restart-required-after-purge-all", health: { mode: "manual", lastError: "restart-required-after-purge-all" } };
    ctx = args.ctx ?? ctx;
    hostVersion = String(args.hostVersion ?? hostVersion);
    hostVersionSource = args.hostVersionSource === "tui-app-version" ? "tui-app-version" : hostVersionSource;
    let recovery = [];
    let synthesisRecovery = [];
    let hiddenSessionRecovery = [];
    try {
      settings();
      store.recoverDecisionTransaction?.();
      synthesisRecovery = pipelineInstance.recoverSynthesisAttempts?.() ?? [];
      const retention = await runRetentionSweep();
      if (!retention.ok) throw new Error(retention.reason ?? "retention-failed");
      recovery = await applier.recoverPending?.() ?? [];
      const applyRecovery = new Map(recovery.map((item) => [item.proposalId, item]));
      const recoveredFailedClosed = new Set();
      for (const proposal of [...latestById(store.readRecords?.("proposal") ?? []).values()].filter((item) => item.state === "approved")) {
        const verified = (store.readRecords?.("audit-event") ?? []).some((record) => record.payload.kind === "apply" && record.payload.proposalId === proposal.id && record.payload.details?.["readback-verified"] === true);
        if (verified) {
          const lease = applier.getApplyLeaseStatus?.(proposal.id);
          if (lease?.held) {
            recovery.push({ ok: true, deferred: true, proposalId: proposal.id, action: "deferred", reason: "lease-busy" });
            continue;
          }
          const finalized = markApplied(proposal.id);
          recovery.push({ ok: finalized?.ok === true, proposalId: proposal.id, action: "completed-applied-state", ...(finalized?.ok ? {} : { reason: finalized?.reason }) });
          continue;
        }
        const recoveredApply = applyRecovery.get(proposal.id);
        if (recoveredApply) {
          if (recoveredApply.deferred || recoveredApply.reason === "lease-busy") continue;
          const failed = markFailedClosed(proposal.id, recoveredApply.reason ?? "apply-not-verified");
          if (failed.ok) recoveredFailedClosed.add(recoveredApply);
          recovery.push({ ok: failed.ok, proposalId: proposal.id, action: "failed-closed" });
          continue;
        }
        const resumed = await runApprovalFlow({ proposalId: proposal.id, actor: "self-evolve-recovery", projectFingerprint: proposal.projectFingerprint });
        if (resumed.result === "applied") {
          const finalized = currentProposal(proposal.id)?.state === "applied" ? { ok: true } : markApplied(proposal.id);
          recovery.push({ ok: finalized?.ok === true, proposalId: proposal.id, action: "resumed-apply", ...(finalized?.ok ? {} : { reason: finalized?.reason }) });
        } else if (resumed.deferred || resumed.reason === "lease-busy") {
          recovery.push({ ok: true, deferred: true, proposalId: proposal.id, action: "deferred", reason: "lease-busy" });
        } else {
          const failed = markFailedClosed(proposal.id, resumed.reason ?? "apply-recovery-failed");
          recovery.push({ ok: failed.ok, proposalId: proposal.id, action: "failed-closed", reason: resumed.reason ?? "apply-recovery-failed" });
        }
      }
      if (args.recoverHostSessions !== false) hiddenSessionRecovery = await recoverOrphanedAnalyzerSessions(ctx?.client, ctx?.directory);
      if (options.stateRoot) {
        issueBridgeNonces();
        issueControlGrant();
        await processMailbox();
        startMailboxPolling();
      }
      startRetentionTimer();
      appendAudit("decision", { action: "boot", hostVersion, hostVersionSource, schemaVersion: schemas.SCHEMA_VERSION, recovered: recovery.length, recoveredSyntheses: synthesisRecovery.length, abortedHiddenSessions: hiddenSessionRecovery.filter((item) => item.ok).length, hiddenSessionRecoveryFailures: hiddenSessionRecovery.filter((item) => !item.ok).length });
      recovery = recovery.map((item) => recoveredFailedClosed.has(item) ? { ...item, recoveredToFailedClosed: true } : item);
    } catch (error) {
      corrupt = true;
      lastError = errorReason(error);
    }
    const mode = syncSchedulerMode(settings()?.repo?.projectFingerprint, "boot");
    return { ok: !corrupt && recovery.every((item) => item.ok !== false || item.recoveredToFailedClosed === true) && synthesisRecovery.every((item) => item.ok) && hiddenSessionRecovery.every((item) => item.ok), mode, recovered: recovery, synthesisRecovery, hiddenSessionRecovery, health: getHealth() };
  }

  async function shutdown() {
    if (closed && !shutdownDegraded) return { ok: true, alreadyClosed: true };
    if (!closed) {
      closed = true;
      hostRecoveryController?.abort();
      clearMailboxInterval(mailboxTimer);
      mailboxTimer = undefined;
      clearRetentionInterval(retentionTimer);
      retentionTimer = undefined;
      await mailboxTask;
      await retentionTask;
      await hostRecoveryTask;
      schedulerInstance.dispose?.();
    }
    const applierClose = await applier.close?.();
    if (applierClose?.ok === false) {
      shutdownDegraded = true;
      return { ok: false, reason: "applier-close-degraded", applier: applierClose };
    }
    synthesisModule?.disposeSynthesis?.();
    if (!terminalPurge) await store.flushAudit?.();
    const storeClose = await store.close?.();
    if (storeClose?.ok === false) {
      shutdownDegraded = true;
      return { ok: false, reason: "store-close-degraded", store: storeClose };
    }
    shutdownDegraded = false;
    return { ok: true };
  }

  const testBridge = Object.freeze({
    getInbox({ projectFingerprint } = {}) {
      const expected = projectFingerprint ?? settings()?.repo?.projectFingerprint;
      return [...latestById(store.readRecords?.("proposal") ?? []).values()]
        .filter((proposal) => proposal.projectFingerprint === expected && ["pending", "failed-closed"].includes(proposal.state))
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
    decide,
    processMailbox,
    issueBridgeNonces,
    issueControlGrant,
    runRetentionSweep,
    __testBridge: testBridge,
    boot,
    recoverHostSessions,
    shutdown,
    triggerKillSwitch,
    clearKillSwitch,
    getRetentionState: () => ({ scheduled: retentionTimer !== undefined, inFlight: retentionTask !== undefined }),
    getInFlightWork: () => [...inFlight.values()].map((item) => ({ ...item })),
  });
}
