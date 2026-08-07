import { createHash } from "node:crypto";
import {
  ConsentState,
  Mode,
  SCHEMA_VERSION,
  makeAuditEvent,
  makeConsentState,
  makeDecision,
  makeGlobalSettings,
  makeRepoSettings,
  resolveMode,
  transitionMode,
  stripUndefined,
  wrapRecord,
} from "./self-evolve-schemas.js";

export const MIGRATION_NOTE = Object.freeze(
  "v0.1.2 -> v0.2: status, pause, resume, scan, and help are unchanged; disable is deprecated and maps to pause; dismiss maps to reject (use snooze to defer); bare /self-evolve scans in legacy contexts and opens status/inbox in new contexts.",
);

const MODES = new Set(Mode.values);
const REPO_MODES = new Set([...MODES, "inherit"]);
const EXPORT_SCOPES = new Set(["observations", "proposals", "project", "all"]);
const PURGE_SCOPES = new Set(["observations", "proposals", "project", "all"]);
const CONSENT_KEYS = Object.freeze({
  passive: "passiveCalls",
  observations: "durableObservations",
  excerpts: "sanitizedExcerpts",
  "cross-repo": "crossRepoAggregation",
});
const RESTART_NOTICE = "OpenCode must be restarted for the new mode to take full effect.";
export const MAX_OBSERVATION_INSPECTION = 100;
const DEFAULT_OBSERVATION_INSPECTION = 20;
export const HEADLESS_APPROVAL_USAGE = "/self-evolve approve <proposal-id> --target-hash <sha256> --proposed-content-hash <sha256> --decision-version <integer> --nonce <one-use-nonce>";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const NONCE_RE = /^[a-f0-9]{48}$/u;
const DISCLOSURES = Object.freeze({
  passiveCalls: "Disclosure: passive provider calls may occur at stable idle boundaries within configured budgets.",
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

export function parseSelfEvolveCommand(input, { legacy = false } = {}) {
  const tokenized = splitInput(input);
  if (tokenized.error) return error(tokenized.error);
  const tokens = tokenized.tokens;
  if (tokens.length === 0) return parsed(legacy ? "scan" : "default");
  const [rawVerb, ...args] = tokens;
  const verb = rawVerb.toLowerCase();
  if (verb === "?") return args.length ? error("Help does not accept arguments.") : parsed("help");
  if (["help", "scan", "status", "pause", "resume", "inbox", "budget", "health"].includes(verb)) {
    return args.length ? error(`/self-evolve ${verb} does not accept arguments.`) : parsed(verb);
  }
  if (verb === "disable") {
    return args.length ? error("/self-evolve disable does not accept arguments.") : parsed("pause", { deprecatedAlias: "disable" });
  }
  if (verb === "dismiss") {
    return args.length > 1 ? error("Usage: /self-evolve dismiss [proposal-id]") : parsed("dismiss", { proposalId: args[0] });
  }
  if (MODES.has(verb)) {
    if (verb !== "yolo") return args.length ? error(`Usage: /self-evolve ${verb}`) : parsed("mode", { mode: verb });
    if (args.length === 0) {
      return parsed("mode", {
        mode: "yolo",
        requiresConfirmation: true,
        confirmationPrompt: "Yolo can apply validated skill changes without per-change approval. Confirm with /self-evolve yolo confirm --allowlist <absolute-root>.",
      });
    }
    if (args.length === 3 && args[0].toLowerCase() === "confirm" && args[1] === "--allowlist" && args[2]) {
      return parsed("mode", { mode: "yolo", confirmed: true, allowlist: [args[2]] });
    }
    return error("Yolo requires explicit confirmation and an allowlist: /self-evolve yolo confirm --allowlist <absolute-root>.");
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
    if (!SHA256_RE.test(values["--target-hash"]) || !SHA256_RE.test(values["--proposed-content-hash"])) return error("Approval hashes must be lowercase 64-character SHA-256 values.");
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
  if (verb === "repo") {
    if (args.length !== 1 || !REPO_MODES.has(args[0].toLowerCase())) return error("Usage: /self-evolve repo <manual|auto|yolo|inherit>");
    return parsed("repo-mode", { mode: args[0].toLowerCase() });
  }
  if (verb === "consent") {
    const key = CONSENT_KEYS[args[0]?.toLowerCase()];
    const value = args[1]?.toLowerCase();
    if (args.length !== 2 || !key || !["on", "off"].includes(value)) {
      return error("Usage: /self-evolve consent <passive|observations|excerpts|cross-repo> <on|off>");
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
    return args.length <= 1 && EXPORT_SCOPES.has(scope) ? parsed("export", { scope }) : error("Usage: /self-evolve export [observations|proposals|project|all]");
  }
  if (verb === "purge") {
    const scope = args[0] === "--all" ? "all" : args[0]?.toLowerCase();
    return args.length === 1 && PURGE_SCOPES.has(scope) ? parsed("purge", { scope }) : error("Usage: /self-evolve purge <observations|proposals|project|all>");
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
    "/self-evolve - open status and the durable inbox (legacy: scan)",
    "/self-evolve help | scan | status | pause | resume | inbox | budget | health",
    "/self-evolve manual | auto | yolo",
    "/self-evolve review [id] | reject <id> | snooze <id> [duration] | undo <id>",
    HEADLESS_APPROVAL_USAGE,
    "The current approval tuple is shown by inbox and review; it contains hashes, version, and a one-use nonce, never proposal content.",
    "/self-evolve exclude | include | repo <manual|auto|yolo|inherit>",
    "/self-evolve consent <passive|observations|excerpts|cross-repo> <on|off>",
    "/self-evolve allowlist list | allowlist <add|remove> <canonical-absolute-path> --confirm UPDATE ALLOWLIST",
    "/self-evolve inspect observations [N] | inspect eligibility [clusterId]",
    "/self-evolve export [observations|proposals|project|all]",
    "/self-evolve purge <observations|proposals|project|all>",
    "/self-evolve kill-switch <on|off>",
    "Legacy aliases: disable -> pause (deprecated); dismiss [id] -> reject when an id is supplied.",
    MIGRATION_NOTE,
  ].join("\n");
}

export function buildResponse(commandValue, outcome = {}) {
  const commandName = commandValue?.verb ?? "unknown";
  if (outcome.error || outcome.ok === false) return `Self-evolve ${commandName} failed: ${outcome.error ?? outcome.reason ?? "unknown error"}. No files were applied.`;
  if (outcome.responseText) return outcome.responseText;
  if (commandName === "help") return helpText();
  if (commandName === "mode" || commandName === "repo-mode") {
    if (commandValue.requiresConfirmation && !commandValue.confirmed) return `${commandValue.confirmationPrompt}\nNo mode change or file application occurred.`;
    return `Self-evolve mode preference changed to ${outcome.mode ?? commandValue.mode}. No proposal was accepted and no files were applied. ${RESTART_NOTICE}`;
  }
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

export function createCommandPolicy({ store, privacy, schemaVersion = SCHEMA_VERSION, hostVersion = "unknown", hostVersionSource = "global-health", now = () => Date.now() } = {}) {
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
    return store.readRecords("circuit-breaker").at(-1)?.payload ?? null;
  }

  function getMode() {
    const current = settingsResult();
    return current.ok ? current.settings.global.mode : "manual";
  }

  function getEffectiveMode({ projectFingerprint } = {}) {
    const current = settingsResult();
    if (!current.ok) return "manual";
    const { global, repo } = current.settings;
    const projectMismatch = projectFingerprint !== undefined && projectFingerprint !== repo.projectFingerprint;
    const breaker = latestCircuitBreaker();
    return resolveMode(global.mode, repo.mode, {
      killSwitchActive: global.killSwitchActive,
      paused: global.paused,
      circuitBreakerOpen: breaker?.open === true,
      processExcluded: repo.excluded || projectMismatch,
      corrupt: false,
    });
  }

  function setMode(mode, opts = {}) {
    if (mode === "yolo") {
      if (!opts.confirmed) return { ok: false, error: "yolo-confirmation-required" };
      if (!Array.isArray(opts.allowlist) || opts.allowlist.length === 0) return { ok: false, error: "yolo-allowlist-required" };
    }
    let transitioned;
    const saved = store.updateSettings((current) => {
      let global = current.global;
      if (mode === "yolo") global = makeGlobalSettings({ ...global, allowedSkillRoots: opts.allowlist, updatedAt: now() });
      transitioned = transitionMode(global, current.repo, { scope: "global", mode }, now(), "self-evolve-command");
      if (!transitioned.ok) throw new Error(transitioned.error);
      return { global: transitioned.state.global };
    });
    if (!saved.ok) return { ok: false, error: saved.reason };
    for (const event of transitioned.events) store.appendRecord(wrapRecord("audit-event", event, event.timestamp));
    return { ok: true, mode: transitioned.state.global.mode, effectiveMode: transitioned.state.effectiveMode, auditEvent: transitioned.events[0] };
  }

  function setRepoMode(mode) {
    let transitioned;
    const saved = store.updateSettings((current) => {
      transitioned = transitionMode(current.global, current.repo, { scope: "repo", mode }, now(), "self-evolve-command");
      if (!transitioned.ok) throw new Error(transitioned.error);
      return { repo: transitioned.state.repo };
    });
    if (!saved.ok) return { ok: false, error: saved.reason };
    for (const event of transitioned.events) store.appendRecord(wrapRecord("audit-event", event, event.timestamp));
    return { ok: true, mode: transitioned.state.repo.mode, effectiveMode: transitioned.state.effectiveMode, auditEvent: transitioned.events[0] };
  }

  function getConsent() {
    const current = settingsResult();
    return current.ok ? current.settings.global.consent : makeConsentState();
  }

  function setConsent(key, value) {
    if (!ConsentState.fields.includes(key) || typeof value !== "boolean") return { ok: false, error: "invalid-consent-setting" };
    let wasEnabled;
    let consent;
    const saved = store.updateGlobalSettings((global) => {
      if (key === "crossRepoAggregation" && value && !global.consent.sanitizedExcerpts) throw new Error("sanitized-excerpts-consent-required");
      if (key === "sanitizedExcerpts" && !value && global.consent.crossRepoAggregation) throw new Error("cross-repository-aggregation-requires-excerpts");
      wasEnabled = global.consent[key];
      consent = makeConsentState({ ...global.consent, [key]: value });
      return makeGlobalSettings({ ...global, consent, updatedAt: now() });
    });
    if (!saved.ok) return { ok: false, error: saved.reason };
    const auditEvent = appendAudit("decision", { action: "consent", key, enabled: value });
    return { ok: true, consent, disclosure: value && !wasEnabled ? DISCLOSURES[key] : undefined, auditEvent };
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
    if (!current.ok) {
      return {
        hostVersion,
        hostVersionSource,
        schemaVersion,
        circuitBreakerOpen: false,
        killSwitchActive: false,
        mode: "manual",
        repoMode: "inherit",
        lastError: `Corrupt or unsupported settings: ${current.error}. Manual/no-write mode is active; only purge is permitted.`,
      };
    }
    const breaker = latestCircuitBreaker();
    return {
      hostVersion,
      hostVersionSource,
      schemaVersion,
      circuitBreakerOpen: breaker?.open === true,
      killSwitchActive: current.settings.global.killSwitchActive,
      mode: current.settings.global.mode,
      repoMode: current.settings.repo.mode,
      ...(breaker?.reason ? { lastError: breaker.reason } : {}),
    };
  }

  function triggerKillSwitch(reason) {
    const saved = store.updateGlobalSettings((global) => makeGlobalSettings({ ...global, killSwitchActive: true, updatedAt: now() }));
    if (!saved.ok) return { ok: false, error: saved.reason };
    const global = saved.settings.global;
    const auditEvent = appendAudit("kill-switch", { action: "on", reason: String(reason || "command"), storedMode: global.mode, effectiveMode: "manual" });
    return { ok: true, auditEvent };
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
    if (store.isTerminal?.()) return { ok: false, terminal: true, responseText: "Self-evolve state was purged. Restart OpenCode to reinitialize durable self-evolve state." };
    const health = getHealth();
    if (health.lastError?.startsWith("Corrupt or unsupported") && verb !== "purge" && verb !== "health") {
      return { responseText: health.lastError };
    }
    if (verb === "help") return { responseText: helpText() };
    if (verb === "default") {
      const inbox = getInbox();
      return { responseText: `Self-evolve status: effective mode ${getEffectiveMode({ projectFingerprint })}.\nInbox: ${inbox.length} pending proposal(s).${inbox.length ? `\n${inbox.map(proposalLine).join("\n")}` : ""}` };
    }
    if (verb === "status") {
      const current = settingsResult().settings;
      const consent = current.global.consent;
      const roots = current.global.allowedSkillRoots;
      return { responseText: `Self-evolve status: stored mode ${health.mode}; effective mode ${getEffectiveMode({ projectFingerprint })}; repo mode ${health.repoMode}; paused ${current.global.paused}; excluded ${current.repo.excluded}.\nConsent: passive ${consent.passiveCalls ? "on" : "off"}; observations ${consent.durableObservations ? "on" : "off"}; excerpts ${consent.sanitizedExcerpts ? "on" : "off"}; cross-repo ${consent.crossRepoAggregation ? "on" : "off"}.\nApproved skill folders (${roots.length}):${roots.length ? `\n${roots.map((root) => `- ${root}`).join("\n")}` : " none"}` };
    }
    if (verb === "health") return { responseText: `Self-evolve health: host ${health.hostVersion}; source ${health.hostVersionSource ?? "global-health"}; schema ${health.schemaVersion}; mode ${health.mode}; repo mode ${health.repoMode}; circuit breaker ${health.circuitBreakerOpen ? "open" : "closed"}; kill switch ${health.killSwitchActive ? "on" : "off"}.${health.lastError ? ` Last error: ${health.lastError}` : ""}` };
    if (verb === "mode") {
      if (commandValue.requiresConfirmation && !commandValue.confirmed) return { responseText: buildResponse(commandValue) };
      const result = setMode(commandValue.mode, { confirmed: commandValue.confirmed, allowlist: commandValue.allowlist });
      return { responseText: buildResponse(commandValue, result), ...(result.auditEvent ? { auditEvent: result.auditEvent } : {}) };
    }
    if (verb === "repo-mode") {
      const current = settingsResult().settings;
      if (commandValue.mode === "yolo" && current.global.allowedSkillRoots.length === 0) return { responseText: buildResponse(commandValue, { ok: false, error: "yolo-allowlist-required" }) };
      const result = setRepoMode(commandValue.mode);
      return { responseText: buildResponse(commandValue, result), ...(result.auditEvent ? { auditEvent: result.auditEvent } : {}) };
    }
    if (verb === "pause" || verb === "resume") {
      const paused = verb === "pause";
      const saved = store.updateGlobalSettings((global) => makeGlobalSettings({ ...global, paused, updatedAt: now() }));
      const deprecation = commandValue.deprecatedAlias ? " Deprecated: /self-evolve disable now maps to pause." : "";
      return { responseText: !saved.ok ? `Self-evolve ${verb} failed: ${saved.reason}.` : `Self-evolve ${paused ? "paused" : "resumed"}.${deprecation} No files were applied.` };
    }
    if (verb === "repo-override") {
      const saved = store.updateRepoSettings((repo) => makeRepoSettings({ ...repo, excluded: commandValue.excluded }));
      return { responseText: !saved.ok ? `Repository override failed: ${saved.reason}.` : `Repository ${commandValue.excluded ? "excluded; autonomous work will be skipped" : "included"}. No files were applied.` };
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
    if (verb === "scan") return { responseText: "A permitted self-evolve cycle was requested. This command result schedules no passive work and applies no files; the server pipeline performs the explicit cycle." };
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
      const archive = commandValue.scope === "all" ? privacy.exportAll() : privacy.exportScope(projectFingerprint);
      const records = commandValue.scope === "observations"
        ? archive.records.filter((record) => record.kind === "observation")
        : commandValue.scope === "proposals"
          ? archive.records.filter((record) => ["proposal", "decision"].includes(record.kind))
          : archive.records;
      return { responseText: JSON.stringify({ ...archive, exportScope: commandValue.scope, records }, null, 2) };
    }
    if (verb === "purge") {
      const result = privacy.purgeScope({ scope: commandValue.scope, projectFingerprint });
      return {
        ...(commandValue.scope === "all" && result.ok !== false ? { terminalPurge: true } : {}),
        responseText: result.ok === false ? `Purge failed: ${result.reason}.` : `Purge ${commandValue.scope} completed: ${JSON.stringify(result.counts)}. ${commandValue.scope === "all" ? "Restart OpenCode before using self-evolve again." : "No skill files were changed."}`,
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
        return { responseText: result.ok ? `Kill switch enabled. Stored mode remains ${getMode()}; effective mode is manual. No files were applied.` : `Kill switch failed: ${result.error}.`, ...(result.auditEvent ? { auditEvent: result.auditEvent } : {}) };
      }
      let snapshot;
      const saved = store.updateGlobalSettings((global, current) => {
        snapshot = current;
        return makeGlobalSettings({ ...global, killSwitchActive: false, updatedAt: now() });
      });
      const auditEvent = !saved.ok ? null : appendAudit("kill-switch", { action: "off", storedMode: saved.settings.global.mode, effectiveMode: resolveMode(saved.settings.global.mode, snapshot.repo.mode, { paused: saved.settings.global.paused, processExcluded: snapshot.repo.excluded }) });
      return { responseText: !saved.ok ? `Kill switch failed: ${saved.reason}.` : `Kill switch disabled. Stored mode remains ${getMode()}. No files were applied.`, ...(auditEvent ? { auditEvent } : {}) };
    }
    return { responseText: "Unknown /self-evolve command. No files were applied." };
  }

  return Object.freeze({ execute, getMode, setMode, getEffectiveMode, getConsent, setConsent, getInbox, getHealth, triggerKillSwitch });
}
