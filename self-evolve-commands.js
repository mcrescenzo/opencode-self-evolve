import { createHash } from "node:crypto";
import {
  V4_SCHEMA_VERSION,
  makeAuditEvent,
  makeDecision,
  stripUndefined,
  wrapRecord,
} from "./self-evolve-schemas.js";

export const MIGRATION_NOTE = Object.freeze(
  "Self-evolve v0.4 uses Automatic recommendations On or Off. Manual/Auto modes, scan, repository modes, Pause/Resume/Disable, and passive consent were removed and are never reinterpreted. Use /self-evolve on, /self-evolve off, project include/exclude, or the retained permission controls.",
);

const EXPORT_SCOPES = new Set(["observations", "proposals", "global-recommendations", "project", "all"]);
const PURGE_SCOPES = new Set(["observations", "project-evidence", "proposals", "global-recommendations", "project", "all"]);
const CONSENT_KEYS = Object.freeze({
  observations: "durableObservations",
  excerpts: "sanitizedExcerpts",
  "cross-repo": "crossRepoAggregation",
});
const REMOVED_COMMANDS = new Set(["scan", "manual", "auto", "yolo", "repo", "pause", "resume", "disable"]);
export const MAX_OBSERVATION_INSPECTION = 100;
const DEFAULT_OBSERVATION_INSPECTION = 20;
export const HEADLESS_APPROVAL_USAGE = "/self-evolve approve <proposal-id> --target-hash <sha256|must-not-exist> --proposed-content-hash <sha256> --decision-version <integer> --nonce <one-use-nonce>";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const PURGE_ALL_CONFIRMATION = "PURGE ALL SELF-EVOLVE 0.4.0";
const REINITIALIZE_CONFIRMATION = "REINITIALIZE SELF-EVOLVE 0.4.0";
const RESET_BREAKER_CONFIRMATION = "RESET SELF-EVOLVE BREAKER 0.3.0";
const NONCE_RE = /^[a-f0-9]{48}$/u;
const MUST_NOT_EXIST = "must-not-exist";
const DISCLOSURES = Object.freeze({
  durableObservations: "Disclosure: bounded structured observations will be stored durably; complete transcripts and raw message bodies are never stored.",
  sanitizedExcerpts: "Disclosure: sanitized excerpts are heuristic redactions, not a secrecy guarantee, and have a short retention window.",
  crossRepoAggregation: "Disclosure: cross-repository aggregation uses only sanitized normalized evidence and excludes repository identifiers.",
});

function error(message) {
  return { ok: false, error: message };
}

function parsed(verb, fields = {}) {
  return { ok: true, command: { verb, ...fields } };
}

function splitInput(input) {
  let text = String(input ?? "").trim();
  if (/^\/self-evolve(?:\s|$)/i.test(text)) text = text.replace(/^\/self-evolve(?:\s+|$)/i, "");
  text = text.trim();
  if (!text) return { tokens: [] };
  const tokens = [];
  let token = "";
  let quote = null;
  let tokenStarted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      if (index + 1 >= text.length) return { error: "Malformed command: trailing escape." };
      token += text[index + 1];
      tokenStarted = true;
      index += 1;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
      tokenStarted = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quote) return { error: "Malformed command: unterminated quote." };
  if (tokenStarted) tokens.push(token);
  return { tokens };
}

export function parseSelfEvolveCommand(input) {
  const tokenized = splitInput(input);
  if (tokenized.error) return error(tokenized.error);
  const tokens = tokenized.tokens;
  if (tokens.length === 0) return parsed("default");
  const [rawVerb, ...args] = tokens;
  const verb = rawVerb.toLowerCase();
  if (verb === "?") return args.length ? error("Help does not accept arguments.") : parsed("help");
  if (["help", "status", "inbox", "budget", "health"].includes(verb)) {
    return args.length ? error(`/self-evolve ${verb} does not accept arguments.`) : parsed(verb);
  }
  if (REMOVED_COMMANDS.has(verb)) {
    return parsed("removed", { removedCommand: verb });
  }
  if (verb === "on" || verb === "off") {
    return args.length
      ? error(`/self-evolve ${verb} does not accept arguments.`)
      : parsed("automatic-recommendations", { enabled: verb === "on" });
  }
  if (verb === "dismiss") {
    return args.length > 1 ? error("Usage: /self-evolve dismiss [proposal-id]") : parsed("dismiss", { proposalId: args[0] });
  }
  if (["review", "reject", "undo"].includes(verb)) {
    if (verb === "review" && args.length <= 1) return parsed(verb, { proposalId: args[0] });
    if (args.length !== 1) return error(`Usage: /self-evolve ${verb} <proposal-id>`);
    return parsed(verb, { proposalId: args[0] });
  }
  if (verb === "approve") {
    if (args.length !== 9 || !args[0] || args[0].startsWith("--")) return error(`Usage: ${HEADLESS_APPROVAL_USAGE}`);
    const values = {};
    const flags = new Set(["--target-hash", "--proposed-content-hash", "--decision-version", "--nonce"]);
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!flags.has(flag) || value === undefined || value.startsWith("--") || Object.hasOwn(values, flag)) return error(`Usage: ${HEADLESS_APPROVAL_USAGE}`);
      values[flag] = value;
    }
    if (Object.keys(values).length !== flags.size) return error(`Usage: ${HEADLESS_APPROVAL_USAGE}`);
    if ((values["--target-hash"] !== MUST_NOT_EXIST && !SHA256_RE.test(values["--target-hash"]))
        || !SHA256_RE.test(values["--proposed-content-hash"])) {
      return error("Approval target hash must be a lowercase 64-character SHA-256 value or must-not-exist; proposed content hash must be a lowercase 64-character SHA-256 value.");
    }
    if (!/^[1-9]\d*$/u.test(values["--decision-version"]) || !Number.isSafeInteger(Number(values["--decision-version"]))) return error("Approval decision version must be a positive safe integer.");
    if (!NONCE_RE.test(values["--nonce"])) return error("Approval nonce must be the server-issued 48-character lowercase hexadecimal value.");
    return parsed("approve", {
      proposalId: args[0],
      targetHash: values["--target-hash"],
      proposedContentHash: values["--proposed-content-hash"],
      decisionVersion: Number(values["--decision-version"]),
      nonce: values["--nonce"],
    });
  }
  if (verb === "snooze") {
    if (args.length < 1 || args.length > 2) return error("Usage: /self-evolve snooze <proposal-id> [duration]");
    return parsed("snooze", { proposalId: args[0], duration: args[1] ?? "1d" });
  }
  if (verb === "exclude" || verb === "include") {
    return args.length ? error(`/self-evolve ${verb} does not accept arguments.`) : parsed("repo-override", { excluded: verb === "exclude" });
  }
  if (verb === "consent") {
    const key = CONSENT_KEYS[args[0]?.toLowerCase()];
    const value = args[1]?.toLowerCase();
    if (args.length !== 2 || !key || !["on", "off"].includes(value)) {
      if (args[0]?.toLowerCase() === "passive") return parsed("removed", { removedCommand: "passive-consent" });
      return error("Usage: /self-evolve consent <observations|excerpts|cross-repo> <on|off>");
    }
    return parsed("consent", { key, value: value === "on" });
  }
  if (verb === "allowlist") {
    const action = args[0]?.toLowerCase();
    if (action === "list" && args.length === 1) return parsed("allowlist", { action });
    if (["add", "remove"].includes(action)
        && args.length === 5
        && args[1]
        && args[2] === "--confirm"
        && args[3] === "UPDATE"
        && args[4] === "ALLOWLIST") {
      return parsed("allowlist", { action, path: args[1], confirmation: "UPDATE ALLOWLIST" });
    }
    return error("Usage: /self-evolve allowlist list | allowlist <add|remove> <canonical-absolute-path> --confirm UPDATE ALLOWLIST");
  }
  if (verb === "inspect") {
    const subject = args[0]?.toLowerCase();
    if (subject === "observations" && args.length <= 2) {
      if (args[1] === undefined) return parsed("inspect", { subject, limit: DEFAULT_OBSERVATION_INSPECTION });
      if (!/^[1-9]\d*$/u.test(args[1])) return error(`Observation limit must be a positive safe integer no greater than ${MAX_OBSERVATION_INSPECTION}.`);
      const limit = Number(args[1]);
      if (!Number.isSafeInteger(limit) || limit > MAX_OBSERVATION_INSPECTION) {
        return error(`Observation limit must be a positive safe integer no greater than ${MAX_OBSERVATION_INSPECTION}.`);
      }
      return parsed("inspect", { subject, limit });
    }
    if (subject === "eligibility" && args.length <= 2) return parsed("inspect", { subject, clusterId: args[1] });
    return error("Usage: /self-evolve inspect observations [N] | inspect eligibility [clusterId]");
  }
  if (verb === "export") {
    const scope = (args[0] ?? "project").toLowerCase();
    return args.length <= 1 && EXPORT_SCOPES.has(scope) ? parsed("export", { scope }) : error("Usage: /self-evolve export [observations|proposals|global-recommendations|project|all]");
  }
  if (verb === "purge") {
    const scope = args[0] === "--all" ? "all" : args[0]?.toLowerCase();
    if (scope === "all") {
      return args[1] === "--confirm" && args.slice(2).join(" ") === PURGE_ALL_CONFIRMATION
        ? parsed("purge", { scope, confirmation: PURGE_ALL_CONFIRMATION })
        : error(`Usage: /self-evolve purge --all --confirm ${PURGE_ALL_CONFIRMATION}`);
    }
    if (scope === "global-recommendation" && args.length === 2 && SHA256_RE.test(args[1])) {
      return parsed("purge", { scope, recommendationId: args[1] });
    }
    return args.length === 1 && PURGE_SCOPES.has(scope)
      ? parsed("purge", { scope })
      : error(`Usage: /self-evolve purge <observations|project-evidence|proposals|global-recommendations|project> | purge global-recommendation <recommendation-id> | purge --all --confirm ${PURGE_ALL_CONFIRMATION}`);
  }
  if (verb === "reinitialize") {
    return args[0] === "--confirm" && args.slice(1).join(" ") === REINITIALIZE_CONFIRMATION
      ? parsed("reinitialize", { confirmation: REINITIALIZE_CONFIRMATION })
      : error(`Usage: /self-evolve reinitialize --confirm ${REINITIALIZE_CONFIRMATION}`);
  }
  if (verb === "reset-breaker") {
    return args[0] === "--confirm" && args.slice(1).join(" ") === RESET_BREAKER_CONFIRMATION
      ? parsed("reset-breaker", { confirmation: RESET_BREAKER_CONFIRMATION })
      : error(`Usage: /self-evolve reset-breaker --confirm ${RESET_BREAKER_CONFIRMATION}`);
  }
  if (verb === "kill-switch") {
    const enabled = args[0]?.toLowerCase();
    return args.length === 1 && ["on", "off"].includes(enabled)
      ? parsed("kill-switch", { enabled: enabled === "on" })
      : error("Usage: /self-evolve kill-switch <on|off>");
  }
  return error(`Unknown /self-evolve command: ${rawVerb}`);
}

function helpText() {
  return [
    "Self-evolve commands:",
    "/self-evolve - show Automatic recommendations status and the durable inbox",
    "/self-evolve help | status | inbox | budget | health",
    "/self-evolve on | off",
    "/self-evolve review [id] | reject <id> | snooze <id> [duration] | undo <id>",
    HEADLESS_APPROVAL_USAGE,
    "The current approval tuple is shown by inbox and review; it contains hashes, version, and a one-use nonce, never proposal content.",
    "/self-evolve exclude | include",
    "/self-evolve consent <observations|excerpts|cross-repo> <on|off>",
    "/self-evolve allowlist list | allowlist <add|remove> <canonical-absolute-path> --confirm UPDATE ALLOWLIST",
    "/self-evolve inspect observations [N] | inspect eligibility [clusterId]",
    "/self-evolve export [observations|proposals|global-recommendations|project|all]",
    `/self-evolve purge <observations|project-evidence|proposals|global-recommendations|project> | purge global-recommendation <recommendation-id> | purge --all --confirm ${PURGE_ALL_CONFIRMATION}`,
    `/self-evolve reinitialize --confirm ${REINITIALIZE_CONFIRMATION}`,
    `/self-evolve reset-breaker --confirm ${RESET_BREAKER_CONFIRMATION}`,
    "/self-evolve kill-switch <on|off>",
    "Compatibility alias: dismiss [id] rejects when an id is supplied.",
    MIGRATION_NOTE,
  ].join("\n");
}

export function buildResponse(commandValue, outcome = {}) {
  const commandName = commandValue?.verb ?? "unknown";
  if (outcome.error || outcome.ok === false) return `Self-evolve ${commandName} failed: ${outcome.error ?? outcome.reason ?? "unknown error"}. No files were applied.`;
  if (outcome.responseText) return outcome.responseText;
  if (commandName === "help") return helpText();
  if (commandName === "approve") return `Proposal ${commandValue.proposalId} approval was processed by the durable server integration from the exact one-use tuple.`;
  if (commandName === "reject" || commandName === "dismiss") return `Proposal ${commandValue.proposalId} rejected. No files were applied.`;
  if (commandName === "undo") {
    return outcome.eligible
      ? `Rollback for proposal ${commandValue.proposalId} is eligible because the current hash still matches the applied hash. Rollback has not yet been applied; the applier must perform and verify it.`
      : `Rollback for proposal ${commandValue.proposalId} refused: ${outcome.reason ?? "not-eligible"}. No files were changed.`;
  }
  return `Self-evolve ${commandName} completed. No files were applied.`;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function durationMs(value) {
  const match = /^(\d+)(m|h|d|w)$/i.exec(String(value));
  if (!match) return null;
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const result = Number(match[1]) * units[match[2].toLowerCase()];
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function createCommandPolicy({ store, privacy, schemaVersion = V4_SCHEMA_VERSION, hostVersion = "unknown", hostVersionSource = "global-health", now = () => Date.now() } = {}) {
  if (!store || typeof store.getSettings !== "function") throw new TypeError("command-store-required");
  if (!privacy || typeof privacy.exportScope !== "function" || typeof privacy.purgeScope !== "function") throw new TypeError("command-privacy-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");

  function settingsResult() {
    try {
      return { ok: true, settings: store.getSettings() };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  function appendAudit(kind, details, proposalId, actor = "self-evolve-command") {
    const timestamp = now();
    const clean = stripUndefined(details);
    const payloadHash = sha256(JSON.stringify(clean));
    const payload = makeAuditEvent({
      id: sha256(JSON.stringify({ kind, clean, proposalId, actor, timestamp })),
      kind,
      ...(proposalId ? { proposalId } : {}),
      actor,
      timestamp,
      payloadHash,
      details: clean,
    });
    const result = store.appendRecord(wrapRecord("audit-event", payload, timestamp));
    return result.ok ? payload : null;
  }

  function latestCircuitBreaker() {
    const stored = store.readRecords("circuit-breaker").at(-1)?.payload ?? null;
    // H5-001: the durable root-global breaker epoch is the cross-process
    // open/closed truth. If it is tripped, report the breaker as open so health
    // and status reflect peer trip writes. A corrupt breaker epoch fails closed.
    if (store.breakerEpochTripped?.() === true) {
      return stored?.open === true
        ? stored
        : { open: true, openedAt: store.breakerEpochState?.()?.trippedAt ?? null, reason: store.breakerEpochReason?.() ?? "breaker-epoch-tripped", tripCount: Math.max(0, Number(stored?.tripCount ?? 0)) };
    }
    return stored;
  }

  function getAutomation() {
    return store.getAutomationState?.() ?? { ok: false, enabled: false, reason: "automation-state-unavailable" };
  }

  function transitionAutomation(action, enabled, permission = null) {
    const current = getAutomation();
    if (!current.ok) return { ok: false, error: current.reason ?? "automation-state-unavailable" };
    const transitionId = `command:${action}:${current.epoch.generation}:${now()}`;
    const result = store.transitionAutomation({
      transitionId,
      expectedGeneration: current.epoch.generation,
      action,
      ...(permission === null ? {} : { permission }),
      enabled,
    });
    return result.ok ? result : { ok: false, error: result.reason };
  }

  function setAutomaticRecommendations(enabled) {
    if (typeof enabled !== "boolean") return { ok: false, error: "invalid-automatic-recommendations-setting" };
    return transitionAutomation("set-automatic-recommendations", enabled);
  }

  function getConsent() {
    const current = getAutomation();
    return current.ok ? current.global.consent : {
      durableObservations: false,
      sanitizedExcerpts: false,
      crossRepoAggregation: false,
    };
  }

  function setConsent(key, value) {
    if (!Object.values(CONSENT_KEYS).includes(key) || typeof value !== "boolean") {
      return { ok: false, error: "invalid-consent-setting" };
    }
    const wasEnabled = getConsent()[key] === true;
    const result = transitionAutomation("set-permission", value, key);
    if (!result.ok) return result;
    return {
      ...result,
      consent: result.settings.consent,
      disclosure: value && !wasEnabled ? DISCLOSURES[key] : undefined,
    };
  }

  function latestAudit(action, proposalId) {
    return store.readRecords("audit-event").filter((record) =>
      record.payload?.details?.action === action && (proposalId === undefined || record.payload?.proposalId === proposalId)).at(-1)?.payload;
  }

  function headlessGrant(proposal) {
    const details = latestAudit("headless-approval-nonce", proposal.id)?.details;
    if (!details || details.expiresAt <= now()
      || details.projectFingerprint !== proposal.projectFingerprint
      || details.subjectId !== proposal.id
      || details.targetHash !== proposal.skillTarget.currentHash
      || details.proposedContentHash !== proposal.proposedContentHash
      || details.decisionVersion !== proposal.decisionVersion + 1
      || details.priorState !== proposal.state
      || details.actor !== "self-evolve-command") return null;
    return details;
  }

  function approvalCommand(proposal) {
    const grant = headlessGrant(proposal);
    return grant
      ? `/self-evolve approve ${proposal.id} --target-hash ${grant.targetHash} --proposed-content-hash ${grant.proposedContentHash} --decision-version ${grant.decisionVersion} --nonce ${grant.nonce}`
      : "Approval tuple unavailable; retry inbox or review after the durable server integration issues the current one-use grant.";
  }

  function proposalLine(proposal) {
    if (proposal.state === "failed-closed") return `${proposal.id}: CRITICAL failed-closed - ${proposal.rationaleText} -> ${proposal.skillTarget.relativePath}\nApply authority revoked; inspect audit/health and resolve manually.`;
    return `${proposal.id}: ${proposal.rationaleText} [${proposal.state}] -> ${proposal.skillTarget.relativePath}\n${approvalCommand(proposal)}`;
  }

  function getInbox() {
    const timestamp = now();
    const latest = new Map();
    for (const record of store.readRecords("proposal")) latest.set(record.payload.id, record.payload);
    return [...latest.values()].filter((proposal) => {
      if (!["pending", "failed-closed"].includes(proposal.state)) return false;
      if (proposal.state === "failed-closed") return true;
      const snooze = latestAudit("snooze", proposal.id);
      return !snooze || snooze.details.snoozedUntil <= timestamp;
    });
  }

  function getHealth() {
    const current = settingsResult();
    const automation = getAutomation();
    if (!current.ok || !automation.ok) {
      return {
        hostVersion,
        hostVersionSource,
        schemaVersion,
        circuitBreakerOpen: false,
        killSwitchActive: false,
        automaticRecommendationsEnabled: false,
        projectExcluded: true,
        lastError: `Corrupt or unsupported settings: ${current.error ?? automation.reason}. Automatic recommendations are Off; only read-only status and recovery are available.`,
      };
    }
    const breaker = latestCircuitBreaker();
    return {
      hostVersion,
      hostVersionSource,
      schemaVersion,
      circuitBreakerOpen: breaker?.open === true,
      killSwitchActive: automation.global.killSwitchActive,
      automaticRecommendationsEnabled: automation.enabled,
      projectExcluded: automation.repo.excluded,
      ...(breaker?.reason ? { lastError: breaker.reason } : {}),
    };
  }

  function triggerKillSwitch(reason) {
    const result = transitionAutomation("set-emergency-stop", true);
    if (!result.ok) return result;
    const auditEvent = appendAudit("kill-switch", {
      action: "on",
      reason: String(reason || "command"),
      automaticRecommendationsEnabled: result.settings.automaticRecommendationsEnabled,
    });
    return { ...result, auditEvent };
  }

  function decide(proposalId, newState, actor = "self-evolve-command") {
    const proposal = store.getRecord("proposal", proposalId)?.payload;
    if (!proposal) return { ok: false, reason: "record-not-found" };
    const timestamp = now();
    const decision = makeDecision({
      proposalId,
      targetHash: proposal.skillTarget.currentHash,
      proposedContentHash: proposal.proposedContentHash,
      decisionVersion: proposal.decisionVersion + 1,
      actor,
      timestamp,
      nonce: sha256(`${proposalId}:${proposal.decisionVersion + 1}:${timestamp}:${newState}`),
      priorState: "pending",
      newState,
    });
    const committed = store.commitDecision(decision);
    return committed.ok ? { ok: true, decision } : { ok: false, reason: committed.reason };
  }

  function execute(commandValue, { projectFingerprint } = {}) {
    const verb = commandValue?.verb;
    if (verb === "removed") {
      return {
        responseText: `${commandValue.removedCommand} was removed in Self-evolve v0.4. ${MIGRATION_NOTE}`,
      };
    }
    if (store.isTerminal?.()) return { ok: false, terminal: true, responseText: "Self-evolve state was purged. Restart OpenCode to reinitialize durable self-evolve state." };
    const health = getHealth();
    if (health.lastError?.startsWith("Corrupt or unsupported") && verb !== "purge" && verb !== "health") {
      return { responseText: health.lastError };
    }
    if (verb === "help") return { responseText: helpText() };
    if (verb === "default") {
      const inbox = getInbox();
      const automation = getAutomation();
      return { responseText: `Automatic recommendations: ${automation.enabled ? "On" : "Off"}.\nInbox: ${inbox.length} pending proposal(s).${inbox.length ? `\n${inbox.map(proposalLine).join("\n")}` : ""}` };
    }
    if (verb === "status") {
      const current = settingsResult().settings;
      const automation = getAutomation();
      const consent = automation.global.consent;
      const roots = current.global.allowedSkillRoots;
      return { responseText: `Automatic recommendations: ${automation.enabled ? "On" : "Off"}; project ${automation.repo.excluded ? "Excluded" : "Included"}; Emergency Stop ${automation.global.killSwitchActive ? "On" : "Off"}.\nPermissions: observations ${consent.durableObservations ? "on" : "off"}; excerpts ${consent.sanitizedExcerpts ? "on" : "off"}; cross-repo ${consent.crossRepoAggregation ? "on" : "off"}.\nCreation-policy suggestions (${roots.length}):${roots.length ? `\n${roots.map((root) => `- ${root}`).join("\n")}` : " none"}` };
    }
    if (verb === "health") return { responseText: `Self-evolve health: host ${health.hostVersion}; source ${health.hostVersionSource ?? "global-health"}; schema ${health.schemaVersion}; Automatic recommendations ${health.automaticRecommendationsEnabled ? "On" : "Off"}; project ${health.projectExcluded ? "Excluded" : "Included"}; circuit breaker ${health.circuitBreakerOpen ? "open" : "closed"}; Emergency Stop ${health.killSwitchActive ? "On" : "Off"}.${health.lastError ? ` Last error: ${health.lastError}` : ""}` };
    if (verb === "automatic-recommendations") {
      const result = setAutomaticRecommendations(commandValue.enabled);
      return {
        responseText: result.ok
          ? `Automatic recommendations ${commandValue.enabled ? "On" : "Off"}.${commandValue.enabled ? " Required data permissions are On." : " Future analysis is stopped; unfinished automatic work is superseded and will not be backfilled after re-enable; published recommendations and explicit actions remain available; retained data was not purged."}`
          : `Automatic recommendations change failed: ${result.error}.`,
        ...(result.auditEvent ? { auditEvent: result.auditEvent } : {}),
      };
    }
    if (verb === "repo-override") {
      const saved = store.setAutomationProjectExcluded?.(commandValue.excluded)
        ?? { ok: false, reason: "automation-project-policy-unavailable" };
      return { responseText: !saved.ok ? `Project participation change failed: ${saved.reason}.` : `Project ${commandValue.excluded ? "Excluded; automatic work will be skipped" : "Included"}. Automatic recommendations preference is unchanged. No files were applied.` };
    }
    if (verb === "consent") {
      const result = setConsent(commandValue.key, commandValue.value);
      return { responseText: result.ok ? `Consent ${commandValue.key} ${commandValue.value ? "enabled" : "disabled"}.${result.disclosure ? ` ${result.disclosure}` : ""}` : `Consent change failed: ${result.error}.`, ...(result.auditEvent ? { auditEvent: result.auditEvent } : {}) };
    }
    if (verb === "inbox") {
      const inbox = getInbox();
      return { responseText: inbox.length ? `Pending proposals (${inbox.length}):\n${inbox.map(proposalLine).join("\n")}` : "The self-evolve inbox has no pending proposals." };
    }
    if (verb === "review") {
      if (!commandValue.proposalId) return execute({ verb: "inbox" }, { projectFingerprint });
      const proposal = store.getRecord("proposal", commandValue.proposalId)?.payload;
      if (proposal?.state === "critic-pending") return { responseText: `Proposal ${proposal.id} is awaiting critic completion and is not reviewable, approvable, or applicable.` };
      return { responseText: proposal ? `Proposal ${proposalLine(proposal)}\nThe tuple is revalidated and consumed once; proposal content is not printed.` : `Proposal ${commandValue.proposalId} was not found.` };
    }
    if (verb === "approve") {
      return { responseText: `Headless approval must be executed by the durable server integration with the exact current tuple. Usage: ${HEADLESS_APPROVAL_USAGE}` };
    }
    if (verb === "reject" || verb === "dismiss") {
      if (!commandValue.proposalId) return { responseText: `Usage: /self-evolve ${verb} <proposal-id>` };
      const state = verb === "approve" ? "approved" : "rejected";
      const result = decide(commandValue.proposalId, state);
      return { responseText: buildResponse(commandValue, result), ...(result.auditEvent ? { auditEvent: result.auditEvent } : {}) };
    }
    if (verb === "snooze") {
      const delay = durationMs(commandValue.duration);
      if (!delay) return { responseText: "Snooze failed: invalid-duration. No files were applied." };
      const proposal = store.getRecord("proposal", commandValue.proposalId)?.payload;
      if (!proposal) return { responseText: "Snooze failed: record-not-found. No files were applied." };
      const timestamp = now();
      const decision = makeDecision({
        proposalId: proposal.id,
        targetHash: proposal.skillTarget.currentHash,
        proposedContentHash: proposal.proposedContentHash,
        decisionVersion: proposal.decisionVersion + 1,
        actor: "self-evolve-command",
        timestamp,
        nonce: sha256(`${proposal.id}:${proposal.decisionVersion + 1}:${timestamp}:snooze`),
        priorState: "pending",
        newState: "pending",
      });
      const committed = store.commitDecision(decision);
      if (!committed.ok) return { responseText: `Snooze failed: ${committed.reason}. No files were applied.` };
      const snoozedUntil = timestamp + delay;
      const auditEvent = appendAudit("decision", { action: "snooze", snoozedUntil, state: "pending" }, commandValue.proposalId);
      return { responseText: `Proposal ${commandValue.proposalId} remains pending and is snoozed until ${new Date(snoozedUntil).toISOString()}. No files were applied.`, ...(auditEvent ? { auditEvent } : {}) };
    }
    if (verb === "inspect") {
      if (commandValue.subject === "observations") {
        const archive = privacy.exportScope(projectFingerprint);
        const records = archive.records.filter((record) => record.kind === "observation").slice(-commandValue.limit);
        return { responseText: `Observations (${records.length}):\n${JSON.stringify(records, null, 2)}` };
      }
      let records = store.readRecords("eligibility-explanation");
      if (commandValue.clusterId) records = records.filter((record) => record.payload.clusterId === commandValue.clusterId);
      return { responseText: `Eligibility records (${records.length}):\n${JSON.stringify(records, null, 2)}` };
    }
    if (verb === "export") {
      const archive = commandValue.scope === "all"
        ? privacy.exportAll()
        : commandValue.scope === "global-recommendations"
          ? privacy.exportGlobalRecommendations()
          : privacy.exportScope(projectFingerprint);
      const records = commandValue.scope === "observations"
        ? archive.records.filter((record) => record.kind === "observation")
        : commandValue.scope === "proposals"
          ? archive.records.filter((record) => ["proposal", "decision"].includes(record.kind))
          : archive.records;
      return { responseText: JSON.stringify({ ...archive, exportScope: commandValue.scope, records }, null, 2) };
    }
    if (verb === "purge") {
      if (commandValue.scope === "all") {
        return {
          ok: false,
          reason: "purge-all-requires-terminal-integration",
          responseText: "Purge all requires terminal integration handling before deletion.",
        };
      }
      const result = privacy.purgeScope({
        scope: commandValue.scope,
        projectFingerprint,
        ...(commandValue.recommendationId ? { recommendationId: commandValue.recommendationId } : {}),
      });
      return {
        responseText: result.ok === false ? `Purge failed: ${result.reason}.` : `Purge ${commandValue.scope} completed: ${JSON.stringify(result.counts)}. No skill files were changed.`,
      };
    }
    if (verb === "undo") {
      const proposal = store.getRecord("proposal", commandValue.proposalId)?.payload;
      const application = latestAudit("apply", commandValue.proposalId);
      if (!proposal || proposal.state !== "applied" || !application) return { responseText: buildResponse(commandValue, { eligible: false, reason: "not-applied" }) };
      const currentHash = application.details.currentHash;
      const appliedHash = application.details.appliedHash;
      const eligible = Boolean(currentHash && appliedHash && currentHash === appliedHash);
      return { responseText: buildResponse(commandValue, { eligible, reason: eligible ? undefined : "hash-drift" }) };
    }
    if (verb === "budget") {
      const current = settingsResult().settings;
      const counts = Object.fromEntries(["observation", "proposal", "decision"].map((kind) => [kind, store.readRecords(kind).length]));
      return { responseText: `Self-evolve budgets: ${JSON.stringify(current.global.budgets)}. Current durable record counts: ${JSON.stringify(counts)}.` };
    }
    if (verb === "kill-switch") {
      if (commandValue.enabled) {
        const result = triggerKillSwitch("command");
        return { responseText: result.ok ? "Kill switch enabled. Automatic recommendations preference is unchanged, but new automatic work and Apply are suppressed. No files were applied." : `Kill switch failed: ${result.error}.`, ...(result.auditEvent ? { auditEvent: result.auditEvent } : {}) };
      }
      const cleared = transitionAutomation("set-emergency-stop", false);
      const auditEvent = !cleared.ok ? null : appendAudit("kill-switch", {
        action: "off",
        automaticRecommendationsEnabled: cleared.settings.automaticRecommendationsEnabled,
      });
      return { responseText: !cleared.ok ? `Kill switch failed: ${cleared.error}.` : "Kill switch disabled. Automatic recommendations preference is unchanged. No files were applied.", ...(auditEvent ? { auditEvent } : {}) };
    }
    return { responseText: "Unknown /self-evolve command. No files were applied." };
  }

  return Object.freeze({
    execute,
    getAutomation,
    setAutomaticRecommendations,
    getConsent,
    setConsent,
    getInbox,
    getHealth,
    triggerKillSwitch,
  });
}
