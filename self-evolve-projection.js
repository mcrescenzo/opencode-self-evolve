import { createHash, randomUUID } from "node:crypto";
import { scanForSecretCanaries, scanForUnsafeContent } from "./self-evolve-inventory.js";
import { deepFreeze } from "./self-evolve-schemas.js";
import { effectiveTokensPerSynthesis } from "./self-evolve-synthesis.js";
import {
  UI_ACTION_CAPABILITIES,
  UI_CAPABILITIES,
  UI_DASHBOARD_CAPABILITIES,
  UI_DASHBOARD_AUTOMATION_STATES,
  UI_DASHBOARD_BLOCKER_DESTINATIONS,
  UI_DASHBOARD_BLOCKER_CODES,
  UI_CYCLE_OUTCOMES,
  UI_DASHBOARD_REASON_CODES,
  UI_DASHBOARD_VERSION,
  UI_PROJECTION_VERSION,
  UI_PROTOCOL_LIMITS,
  GLOBAL_CAPABILITIES,
  GLOBAL_PROJECTION_VERSION,
  GLOBAL_PROTOCOL_LIMITS,
  PROJECT_PARTICIPATION_VERSION,
  assertUiProjectionFootprint,
  canonicalUiJson,
  globalRootPolicyConfirmation,
  hashUiProtocol,
  makeUiDashboard,
  makeUiOverflowMarker,
  makeUiProjectionIndex,
  makeUiReviewDetail,
  hashGlobalProtocol,
  makeGlobalActionGrant,
  makeGlobalRecommendationDetail,
  makeGlobalRecommendationIndex,
  makeProjectParticipationSidecar,
} from "./self-evolve-ui-protocol.js";

const REVIEWABLE_STATES = new Set(["pending", "approved", "applied", "failed-closed"]);
const HASH_RE = /^[a-f0-9]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const REASON_CODE_RE = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const CHECK_NAME_RE = /^[A-Za-z][A-Za-z0-9.-]{0,63}$/u;
const PRIVATE_ID_RE = /\b(?:msg|message|ses|session)_[A-Za-z0-9_-]{4,}\b/u;
const PRIVATE_PROPOSAL_ID_RE = /^(?:msg|message|ses|session)_/u;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const MAX_DETAIL_REVISION = 1_000_000;
const CYCLE_OUTCOMES = new Set(UI_CYCLE_OUTCOMES);
const DASHBOARD_REASONS = new Set(UI_DASHBOARD_REASON_CODES);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function truncateUtf8(value, maxBytes) {
  let output = "";
  let bytes = 0;
  for (const character of String(value)) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    output += character;
    bytes += width;
  }
  return output;
}

function safeText(value, fallback = "Unavailable.", maxBytes = UI_PROTOCOL_LIMITS.summaryBytes) {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(CONTROL_RE, "\uFFFD");
  const source = clean || fallback;
  if (Buffer.byteLength(source, "utf8") <= maxBytes) return source;
  const marker = " [truncated]";
  return `${truncateUtf8(source, Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8")))}${marker}`;
}

export function containsPrivateMaterial(value) {
  const source = String(value ?? "");
  return PRIVATE_ID_RE.test(source)
    || scanForSecretCanaries(source).flagged
    || scanForUnsafeContent(source).flagged;
}

function sanitizeProposalId(value) {
  return typeof value === "string"
    && ID_RE.test(value)
    && !PRIVATE_PROPOSAL_ID_RE.test(value)
    ? value
    : null;
}

function canonicalBytes(value) {
  return Buffer.byteLength(canonicalUiJson(value), "utf8");
}

function overflowMarker(includedCount, omittedValues, reason = "item-limit") {
  if (!omittedValues.length) return makeUiOverflowMarker(includedCount);
  let omittedBytes = 0;
  for (const value of omittedValues) omittedBytes += canonicalBytes(value);
  return {
    truncated: true,
    includedCount,
    omittedCount: omittedValues.length,
    omittedBytes,
    reason,
  };
}

function bounded(values, maximum, reason = "item-limit") {
  const included = values.slice(0, maximum);
  return {
    included,
    overflow: overflowMarker(included.length, values.slice(maximum), reason),
  };
}

function recordsByKind(snapshot) {
  const output = new Map();
  for (const envelope of snapshot.records ?? []) {
    const kind = envelope?.kind;
    if (typeof kind !== "string" || !envelope?.payload) continue;
    const values = output.get(kind) ?? [];
    values.push(envelope);
    output.set(kind, values);
  }
  return output;
}

function latestPayloads(records, idOf) {
  const output = new Map();
  for (const record of records ?? []) {
    const id = idOf(record.payload);
    if (id !== undefined && id !== null) output.set(id, { payload: record.payload, createdAt: record.createdAt });
  }
  return output;
}

function decodeProposalContent(proposal, contentRecords) {
  const matching = (contentRecords ?? [])
    .map((record) => record.payload)
    .filter((chunk) => chunk.proposalId === proposal.id && chunk.contentHash === proposal.proposedContentHash)
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (!matching.length) return { ok: false, reason: "proposal-content-unavailable", content: null };
  const chunkCount = matching[0].chunkCount;
  if (chunkCount !== matching.length
      || matching.some((chunk, index) => chunk.chunkIndex !== index || chunk.chunkCount !== chunkCount)) {
    return { ok: false, reason: "proposal-content-incomplete", content: null };
  }
  const encoded = matching.map((chunk) => chunk.content).join("");
  let content;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("non-canonical-base64");
    content = bytes.toString("utf8");
  } catch {
    return { ok: false, reason: "proposal-content-malformed", content: null };
  }
  if (sha256(content) !== proposal.proposedContentHash) {
    return { ok: false, reason: "proposal-content-hash-mismatch", content: null };
  }
  if (containsPrivateMaterial(content)) {
    return { ok: false, reason: "proposal-content-privacy-rejected", content: null };
  }
  return { ok: true, reason: null, content };
}

function normalizeTargetRead(value) {
  if (!value || typeof value !== "object") return { available: false, exists: null, hash: null, content: null };
  const exists = value.exists === true;
  const content = typeof value.content === "string"
    ? value.content
    : Buffer.isBuffer(value.content)
      ? value.content.toString("utf8")
      : null;
  const calculated = content === null ? null : sha256(content);
  const hash = HASH_RE.test(String(value.hash ?? "")) ? String(value.hash) : calculated;
  if (exists && (content === null || !hash || calculated !== hash)) {
    return { available: false, exists, hash: null, content: null };
  }
  if (!exists && content !== null) return { available: false, exists, hash: null, content: null };
  return { available: true, exists, hash: exists ? hash : null, content };
}

function readTargets(proposals, targetReader) {
  const output = new Map();
  for (const proposal of proposals) {
    let value;
    try {
      value = normalizeTargetRead(targetReader?.(proposal));
    } catch {
      value = { available: false, exists: null, hash: null, content: null };
    }
    output.set(proposal.id, value);
  }
  return output;
}

function targetDescriptor(proposal, target) {
  return {
    proposalId: proposal.id,
    available: target.available,
    exists: target.exists,
    hash: target.hash,
  };
}

function assertTargetsStable(proposals, first, second) {
  for (const proposal of proposals) {
    const left = targetDescriptor(proposal, first.get(proposal.id));
    const right = targetDescriptor(proposal, second.get(proposal.id));
    if (canonicalUiJson(left) !== canonicalUiJson(right)) throw new Error("target-content-changed-during-projection");
  }
}

function targetIntegrity(proposal, target, appliedAudit) {
  if (!target.available) return { ok: false, reason: "target-unavailable" };
  if (proposal.state === "applied") {
    const appliedHash = appliedAudit?.details?.appliedHash;
    return HASH_RE.test(String(appliedHash)) && target.exists && target.hash === appliedHash
      ? { ok: true, reason: null }
      : { ok: false, reason: "applied-target-drift" };
  }
  if (proposal.skillTarget.currentHash === "must-not-exist") {
    return target.exists === false
      ? { ok: true, reason: null }
      : { ok: false, reason: "target-created-since-proposal" };
  }
  return target.exists && target.hash === proposal.skillTarget.currentHash
    ? { ok: true, reason: null }
    : { ok: false, reason: "target-drift" };
}

function inventoryIntegrity(proposal, target, inventory, allowedSkillRoots) {
  if (!allowedSkillRoots.includes(proposal.skillTarget.canonicalRoot)) {
    return { ok: false, reason: "target-root-not-allowlisted" };
  }
  if (!Array.isArray(inventory)) return { ok: false, reason: "inventory-unavailable" };
  const matches = inventory.filter((record) => record?.canonicalRoot === proposal.skillTarget.canonicalRoot
    && record?.relativePath === proposal.skillTarget.relativePath);
  if (proposal.skillTarget.currentHash === "must-not-exist") {
    return matches.some((record) => record.exists !== false)
      ? { ok: false, reason: "inventory-target-exists" }
      : { ok: true, reason: null };
  }
  if (matches.length !== 1 || matches[0].exists !== true) return { ok: false, reason: "inventory-target-missing-or-ambiguous" };
  return matches[0].currentHash === target.hash
    ? { ok: true, reason: null }
    : { ok: false, reason: "inventory-target-drift" };
}

function combineIntegrity(...values) {
  return values.find((value) => !value.ok) ?? { ok: true, reason: null };
}

function splitUtf8(value, maxBytes) {
  const chunks = [];
  let current = "";
  let bytes = 0;
  for (const character of String(value)) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes && current) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += width;
  }
  chunks.push(current);
  return chunks;
}

function rawDiffLines(relativePath, current, proposed, isNew) {
  if (!isNew && current === proposed) return [];
  const lines = [isNew ? "--- /dev/null" : `--- ${relativePath}`, `+++ ${relativePath}`];
  if (!isNew) {
    for (const line of String(current).split(/\r?\n/u)) lines.push(`-${line}`);
  }
  for (const line of String(proposed).split(/\r?\n/u)) lines.push(`+${line}`);
  return lines.flatMap((line) => splitUtf8(safeText(line, " "), 1_024));
}

function makeDiff(proposal, target, content, integrity) {
  if (!content.ok || !integrity.ok || (target.content !== null && containsPrivateMaterial(target.content))) {
    return {
      kind: "unavailable",
      lines: [],
      overflow: makeUiOverflowMarker(0),
    };
  }
  const source = rawDiffLines(
    proposal.skillTarget.relativePath,
    target.content ?? "",
    content.content,
    proposal.skillTarget.currentHash === "must-not-exist",
  );
  const included = [];
  let bytes = 0;
  for (const line of source) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (included.length >= UI_PROTOCOL_LIMITS.diffLines || bytes + lineBytes > UI_PROTOCOL_LIMITS.diffBytes) break;
    included.push(line);
    bytes += lineBytes;
  }
  const omitted = source.slice(included.length);
  return {
    kind: proposal.skillTarget.currentHash === "must-not-exist" ? "new-file" : "unified",
    lines: included,
    overflow: overflowMarker(
      included.length,
      omitted,
      included.length >= UI_PROTOCOL_LIMITS.diffLines ? "item-limit" : "byte-limit",
    ),
  };
}

function eligibilityFor(proposal, eligibilityRecords) {
  const item = [...(eligibilityRecords ?? [])].reverse()
    .map((record) => record.payload)
    .find((candidate) => candidate.clusterId === proposal.clusterId);
  if (!item) {
    return {
      eligible: false,
      reasons: ["eligibility-record-unavailable"],
      checks: [],
    };
  }
  const checks = [];
  for (const [met, values] of [[true, item.thresholdsMet], [false, item.thresholdsMissed]]) {
    for (const [name, value] of Object.entries(values ?? {})) {
      const match = typeof value === "string"
        ? /^([0-9]+(?:\.[0-9]+)?) \(actual ([0-9]+(?:\.[0-9]+)?)\)$/u.exec(value)
        : null;
      const scale = match && (match[1].includes(".") || match[2].includes(".")) ? 1_000 : 1;
      const required = match ? Math.round(Number(match[1]) * scale) : 1;
      const actual = match ? Math.round(Number(match[2]) * scale) : value === true ? 1 : 0;
      const safeName = CHECK_NAME_RE.test(name) ? name : `redacted-${sha256(name).slice(0, 16)}`;
      checks.push({ name: safeText(safeName, "redacted-check", 64), met, actual, required });
    }
  }
  checks.sort((left, right) => left.name.localeCompare(right.name));
  return {
    eligible: item.eligible === true,
    reasons: [...new Set((item.reasons ?? []).map((reason) => containsPrivateMaterial(reason)
      ? "eligibility-reason-redacted"
      : safeText(reason, "eligibility-reason-unavailable", UI_PROTOCOL_LIMITS.reasonBytes)))].sort(),
    checks: checks.slice(0, UI_PROTOCOL_LIMITS.eligibilityReasons),
  };
}

function evidenceFor(proposal, clusterRecords) {
  const cluster = [...(clusterRecords ?? [])].reverse()
    .map((record) => record.payload)
    .find((candidate) => candidate.id === proposal.clusterId);
  if (!cluster) return [];
  return [{
    id: cluster.id,
    kind: cluster.receiptType,
    summary: `${cluster.occurrencesSum} sanitized occurrence(s) across ${cluster.incidentIds.length} independent incident(s).`,
    occurredAt: cluster.lastSeenAt,
    redacted: true,
  }];
}

function auditSummary(event) {
  if (event.kind === "apply" && event.details?.["readback-verified"] === true) return "Apply completed and readback was verified.";
  if (event.kind === "apply") return "Apply activity was recorded.";
  if (event.kind === "rollback" && event.details?.["readback-verified"] === true) return "Rollback completed and readback was verified.";
  if (event.kind === "rollback") return "Rollback activity was recorded.";
  if (event.kind === "decision") return "A proposal decision was recorded.";
  if (event.kind === "corruption") return "A fail-closed corruption event was recorded.";
  if (event.kind === "lease") return "A bounded lease event was recorded.";
  if (event.kind === "kill-switch") return "A kill-switch event was recorded.";
  if (event.kind === "purge") return "A data-maintenance event was recorded.";
  return "A settings event was recorded.";
}

function auditFor(proposal, auditRecords) {
  return (auditRecords ?? [])
    .map((record) => record.payload)
    .map((event) => ({
      id: event.id,
      kind: event.kind,
      summary: auditSummary(event),
      timestamp: event.timestamp,
    }))
    .sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id));
}

function latestAppliedAudit(proposal, auditRecords) {
  return [...(auditRecords ?? [])].reverse()
    .map((record) => record.payload)
    .find((event) => event.kind === "apply"
      && event.details?.["readback-verified"] === true
      && HASH_RE.test(String(event.details?.appliedHash ?? "")));
}

function matchingLegacyGrant(proposal, auditRecords, now) {
  return [...(auditRecords ?? [])].reverse()
    .map((record) => record.payload)
    .find((event) => {
      const value = event.details;
      return event.kind === "decision"
        && event.actor === "self-evolve-integration"
        && value?.action === "bridge-nonce"
        && value.projectFingerprint === proposal.projectFingerprint
        && value.subjectId === proposal.id
        && value.targetHash === proposal.skillTarget.currentHash
        && value.proposedContentHash === proposal.proposedContentHash
        && value.decisionVersion === proposal.decisionVersion + 1
        && value.priorState === proposal.state
        && value.actor === "self-evolve-tui"
        && ID_RE.test(String(value.nonce ?? ""))
        && Number.isSafeInteger(value.expiresAt)
        && value.expiresAt > now;
    })?.details ?? null;
}

function uiOperationGrants(auditRecords, context) {
  const latest = new Map();
  for (const record of auditRecords ?? []) {
    const event = record.payload;
    const value = event.details;
    if (event.kind !== "decision"
        || event.actor !== "self-evolve-integration"
        || value?.action !== "ui-operation-nonce"
        || value.projectFingerprint !== context.projectFingerprint
        || value.stateRootIdentity !== context.stateRootIdentity
        || value.generation !== context.generation
        || UI_ACTION_CAPABILITIES[value.uiAction] !== value.capability
        || !context.capabilities.includes(value.capability)
        || (value.subjectId !== undefined && !ID_RE.test(String(value.subjectId)))
        || !ID_RE.test(String(value.nonce ?? ""))
        || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= context.now) continue;
    latest.set(`${value.subjectId ?? ""}\n${value.uiAction}`, value);
  }
  return latest;
}

function actionGrant(action, grant, expiresAt) {
  return {
    action,
    capability: UI_ACTION_CAPABILITIES[action],
    nonce: grant.nonce,
    expiresAt: Math.min(grant.expiresAt, expiresAt),
  };
}

function detailAllowedActions({
  proposal,
  effectiveMode,
  integrity,
  content,
  appliedAudit,
  legacyGrant,
  operationGrants,
  expiresAt,
  authorityReady,
  capabilities,
}) {
  if (!authorityReady || !integrity.ok || !content.ok || proposal.state === "failed-closed" || proposal.state === "critic-pending") return [];
  const actions = [];
  if (proposal.state === "pending" && legacyGrant && capabilities.includes("legacy-decision-v1")) {
    if (effectiveMode === "auto" && proposal.criticPassed && proposal.validDeterministic && !proposal.injectionFlagged) {
      actions.push(actionGrant("apply-proposal", legacyGrant, expiresAt));
    }
    actions.push(actionGrant("reject-proposal", legacyGrant, expiresAt));
  }
  if (proposal.state === "pending") {
    const grant = operationGrants.get(`${proposal.id}\nsnooze-proposal`);
    if (grant) actions.push(actionGrant("snooze-proposal", grant, expiresAt));
  }
  if (proposal.state === "applied") {
    if (capabilities.includes(UI_ACTION_CAPABILITIES["acknowledge-audit"])) {
      actions.push({
        action: "acknowledge-audit",
        capability: UI_ACTION_CAPABILITIES["acknowledge-audit"],
        nonce: null,
        expiresAt: null,
      });
    }
    const grant = operationGrants.get(`${proposal.id}\nrollback-proposal`);
    if (grant && appliedAudit) actions.push(actionGrant("rollback-proposal", grant, expiresAt));
  }
  return actions.sort((left, right) => left.action.localeCompare(right.action));
}

function riskFor(proposal, integrity, content) {
  if (proposal.state === "failed-closed" || proposal.injectionFlagged || !integrity.ok || !content.ok) return "critical";
  if (!proposal.criticPassed || !proposal.validDeterministic) return "high";
  if (proposal.skillTarget.currentHash === "must-not-exist") return "medium";
  return "low";
}

function attentionFor(risk) {
  if (risk === "critical") return "critical";
  if (risk === "high" || risk === "medium") return "warning";
  return "normal";
}

function rollbackFor(proposal, target, appliedAudit) {
  if (proposal.state !== "applied") return { eligible: false, reason: "not-applied", appliedHash: null };
  if (!appliedAudit) return { eligible: false, reason: "verified-apply-audit-unavailable", appliedHash: null };
  const appliedHash = appliedAudit.details.appliedHash;
  if (!target.available || !target.exists || target.hash !== appliedHash) {
    return { eligible: false, reason: "current-target-does-not-match-applied-hash", appliedHash };
  }
  return { eligible: true, reason: null, appliedHash };
}

function operationsFor(auditRecords) {
  const latest = new Map();
  for (const record of auditRecords ?? []) {
    const event = record.payload;
    const value = event.details;
    if (event.kind !== "decision"
        || value?.action !== "ui-operation-status"
        || !ID_RE.test(String(value.requestId ?? ""))
        || PRIVATE_ID_RE.test(value.requestId)
        || !Object.hasOwn(UI_ACTION_CAPABILITIES, value.uiAction)
        || !["queued", "running", "completed", "failed", "accepted-terminal"].includes(value.status)) continue;
    latest.set(value.requestId, {
      requestId: value.requestId,
      action: value.uiAction,
      status: value.status,
      updatedAt: event.timestamp,
      reason: value.status === "failed" ? "operation-failed" : null,
    });
  }
  return [...latest.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.requestId.localeCompare(right.requestId));
}

function latestDetailOperation(proposalId, operations, auditRecords) {
  const subjectRequests = new Set((auditRecords ?? [])
    .map((record) => record.payload?.details)
    .filter((details) => details?.action === "ui-operation-status" && details.subjectId === proposalId)
    .map((details) => details.requestId));
  const operation = operations.find((candidate) => subjectRequests.has(candidate.requestId));
  return operation
    ? { status: operation.status, requestId: operation.requestId, reason: operation.reason, updatedAt: operation.updatedAt }
    : { status: "idle", requestId: null, reason: null, updatedAt: null };
}

function detailRevision(proposalId, byKind) {
  let count = 0;
  for (const records of byKind.values()) {
    for (const record of records) {
      if (record.kind === "proposal" && record.payload.id === proposalId) count += 1;
      else if (record.payload?.proposalId === proposalId) count += 1;
    }
  }
  if (count > MAX_DETAIL_REVISION) throw new Error("detail-revision-out-of-bounds");
  return count;
}

function statusFrom(settings, health, breakerOpen) {
  const backgroundRestartRequired = health.lifecycleEventHookInstalled === false;
  const state = health.state
    ?? (health.terminal ? "terminal"
      : health.corrupt ? "corrupt"
        : health.startupPending ? "startup-pending"
          : health.setupRequired || backgroundRestartRequired ? "setup-required"
            : health.unavailable ? "unavailable"
              : "ready");
  return {
    state,
    reason: state === "ready"
      ? null
      : backgroundRestartRequired
        ? "restart-required"
        : REASON_CODE_RE.test(String(health.reason ?? ""))
          ? String(health.reason)
          : state,
    automaticRecommendationsEnabled: settings.global.automaticRecommendationsEnabled,
    killSwitchActive: settings.global.killSwitchActive || health.runtimeKillSwitch === true,
    repoExcluded: settings.repo.excluded,
    circuitBreakerOpen: breakerOpen,
  };
}

function mergedBudgets(settings) {
  const { notificationsPerHour: _legacyNotificationBudget, ...budgets } = {
    ...settings.global.budgets,
    ...settings.repo.budgets,
  };
  return budgets;
}

function indexAllowedActions(operationGrants, expiresAt, statusState) {
  if (statusState !== "ready") {
    const retry = operationGrants.get("\nretry-bootstrap");
    return retry ? [actionGrant("retry-bootstrap", retry, expiresAt)] : [];
  }
  const output = [];
  for (const action of [
    "export-data",
    "purge-all",
    "purge-scope",
    "set-automatic-recommendations",
    "set-kill-switch",
    "set-permission",
    "set-repo-excluded",
  ]) {
    const grant = operationGrants.get(`\n${action}`);
    if (grant) output.push(actionGrant(action, grant, expiresAt));
  }
  return output.sort((left, right) => left.action.localeCompare(right.action));
}

function exactFieldSet(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function cycleTriggerClass(value) {
  return ["manual", "idle", "recovery", "other"].includes(value) ? value : "other";
}

function cycleAuditValue(record) {
  const event = record?.payload;
  const details = event?.details;
  const legacyFields = [
    "action", "outcome", "triggerClass", "mode", "observationCount",
    "eligibilityCount", "occurredAt", "reason",
  ];
  const currentFields = legacyFields.filter((field) => field !== "mode");
  const legacy = exactFieldSet(details, legacyFields);
  if (record?.kind !== "audit-event"
      || event?.kind !== "decision"
      || event.actor !== "self-evolve-integration"
      || (!legacy && !exactFieldSet(details, currentFields))
      || details.action !== "cycle-outcome"
      || !CYCLE_OUTCOMES.has(details.outcome)
      || (legacy && !["manual", "auto", "yolo"].includes(details.mode))
      || !Number.isSafeInteger(details.observationCount)
      || details.observationCount < 0
      || !Number.isSafeInteger(details.eligibilityCount)
      || details.eligibilityCount < 0
      || !Number.isSafeInteger(details.occurredAt)
      || details.occurredAt !== event.timestamp
      || (details.reason !== null && !DASHBOARD_REASONS.has(details.reason))) return null;
  return {
    outcome: details.outcome,
    triggerClass: cycleTriggerClass(details.triggerClass),
    observationCount: details.observationCount,
    eligibilityCount: details.eligibilityCount,
    proposalId: sanitizeProposalId(event.proposalId),
    occurredAt: event.timestamp,
    reason: details.reason,
  };
}

function cycleSummary(outcome) {
  return {
    "cursor-unchanged": "No duplicate work was created because this activity was already processed.",
    "no-observations": "The cycle completed without new structured observations.",
    "not-eligible": "Saved structured patterns are not yet eligible for a recommendation.",
    "valid-no-change": "Analysis completed successfully and found no useful safe change.",
    "recommendation-created": "A recommendation was created and is ready for review.",
    applied: "A recommendation was applied and verified.",
    deferred: "The cycle was safely deferred.",
    "failed-closed": "The cycle stopped without granting or applying unsafe authority.",
    failed: "The cycle failed before it could complete.",
  }[outcome] ?? "A Self-evolve cycle completed.";
}

function semanticActivity(records) {
  const output = [];
  for (const record of records ?? []) {
    const cycle = cycleAuditValue(record);
    if (cycle) {
      output.push({
        id: record.payload.id,
        category: ["failed", "failed-closed"].includes(cycle.outcome) ? "error" : "cycle",
        audience: "default",
        outcome: cycle.outcome,
        summary: cycleSummary(cycle.outcome),
        occurredAt: cycle.occurredAt,
        proposalId: cycle.proposalId,
        reason: cycle.reason,
      });
      continue;
    }
    const event = record?.payload;
    if (record?.kind === "decision"
        && ["approved", "rejected", "rolled-back"].includes(event?.newState)
        && Number.isSafeInteger(event?.timestamp)) {
      const outcome = {
        approved: "recommendation-approved",
        rejected: "recommendation-rejected",
        "rolled-back": "rolled-back",
      }[event.newState];
      output.push({
        id: record.id,
        category: "recommendation",
        audience: "default",
        outcome,
        summary: event.newState === "approved"
          ? "A recommendation was approved for fresh server-side validation."
          : event.newState === "rejected"
            ? "A recommendation was dismissed without changing skill files."
            : "A recommendation was approved for rollback.",
        occurredAt: event.timestamp,
        proposalId: sanitizeProposalId(event.proposalId),
        reason: null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "apply"
        && event.details?.["readback-verified"] === true) {
      output.push({
        id: event.id,
        category: "recommendation",
        audience: "default",
        outcome: "applied",
        summary: "A Self-evolve change was applied and readback was verified.",
        occurredAt: event.timestamp,
        proposalId: sanitizeProposalId(event.proposalId),
        reason: null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "decision"
        && event.details?.action === "snooze"
        && Number.isSafeInteger(event.details?.snoozedUntil)) {
      output.push({
        id: event.id,
        category: "recommendation",
        audience: "default",
        outcome: "recommendation-snoozed",
        summary: "A recommendation remains pending and was snoozed until the requested time.",
        occurredAt: event.timestamp,
        proposalId: sanitizeProposalId(event.proposalId),
        reason: null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "mode-change"
        && event.details?.action === "automation-control"
        && ["set-automatic-recommendations", "set-permission"].includes(event.details?.control)) {
      const turnedOn = event.details.enabled === true;
      output.push({
        id: event.id,
        category: "system",
        audience: "default",
        outcome: turnedOn ? "automatic-recommendations-on" : "automatic-recommendations-off",
        summary: turnedOn
          ? "Automatic recommendations were turned on."
          : "Automatic recommendations were turned off.",
        occurredAt: event.timestamp,
        proposalId: null,
        reason: turnedOn ? null : "automatic-recommendations-off",
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "mode-change"
        && ["exclude", "include"].includes(event.details?.action)) {
      const excluded = event.details.action === "exclude";
      output.push({
        id: event.id,
        category: "system",
        audience: "default",
        outcome: excluded ? "project-excluded" : "project-included",
        summary: excluded
          ? "This project was excluded from automatic recommendations."
          : "This project was included in automatic recommendations.",
        occurredAt: event.timestamp,
        proposalId: null,
        reason: excluded ? "repository-excluded" : null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "kill-switch"
        && ["on", "off"].includes(event.details?.action)) {
      output.push({
        id: event.id,
        category: "system",
        audience: "default",
        outcome: event.details.action === "on" ? "emergency-stop-enabled" : "emergency-stop-disabled",
        summary: event.details.action === "on"
          ? "Emergency stop disabled automatic provider calls and writes."
          : "Emergency stop was turned off after review.",
        occurredAt: event.timestamp,
        proposalId: null,
        reason: event.details.action === "on" ? "emergency-stop" : null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "decision"
        && event.details?.action === "ui-operation-complete"
        && event.details?.accepted === true
        && ["export-data", "purge-scope", "purge-all"].includes(event.details?.uiAction)) {
      const purgeAll = event.details.uiAction === "purge-all";
      output.push({
        id: event.id,
        category: "system",
        audience: "default",
        outcome: event.details.uiAction === "export-data"
          ? "export-completed"
          : purgeAll ? "purge-all-accepted" : "purge-completed",
        summary: event.details.uiAction === "export-data"
          ? "A private, short-lived sensitive export was completed."
          : purgeAll
            ? "A full purge was accepted and Self-evolve stopped its authority."
            : "A scoped purge completed.",
        occurredAt: event.timestamp,
        proposalId: null,
        reason: null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "decision"
        && event.details?.action === "boot"
        && typeof event.details?.hostVersion === "string") {
      const recovered = Number.isSafeInteger(event.details.recovered) && event.details.recovered > 0;
      output.push({
        id: event.id,
        category: "system",
        audience: "default",
        outcome: recovered ? "recovery-completed" : "bootstrap-completed",
        summary: recovered
          ? "Startup checks completed and bounded recovery work was reconciled."
          : "Startup checks completed successfully.",
        occurredAt: event.timestamp,
        proposalId: null,
        reason: null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "rollback"
        && event.details?.["readback-verified"] === true) {
      output.push({
        id: event.id,
        category: "recommendation",
        audience: "default",
        outcome: "rolled-back",
        summary: "A Self-evolve change was rolled back and readback was verified.",
        occurredAt: event.timestamp,
        proposalId: sanitizeProposalId(event.proposalId),
        reason: null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.actor === "self-evolve-scheduler"
        && event.details?.action === "work-failure"
        && Number.isSafeInteger(event.details?.backoffUntil)) {
      output.push({
        id: event.id,
        category: "error",
        audience: "default",
        outcome: "failed",
        summary: "Automatic work failed and entered bounded backoff.",
        occurredAt: event.timestamp,
        proposalId: null,
        reason: "backoff",
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.actor === "self-evolve-scheduler"
        && event.details?.action === "schedule-suppressed"
        && ["quiet-period", "budget-exhausted"].includes(event.details?.reason)) {
      output.push({
        id: event.id,
        category: "system",
        audience: "diagnostic",
        outcome: "deferred",
        summary: event.details.reason === "quiet-period"
          ? "Automatic work waited for the configured quiet period."
          : "Automatic work waited because a configured budget was exhausted.",
        occurredAt: event.timestamp,
        proposalId: null,
        reason: event.details.reason === "quiet-period" ? "quiet-period" : "synthesis-budget-exhausted",
      });
      continue;
    }
    if (record?.kind === "circuit-breaker" && typeof event?.open === "boolean") {
      output.push({
        id: record.id,
        category: event.open ? "error" : "system",
        audience: "default",
        outcome: event.open ? "breaker-open" : "breaker-recovered",
        summary: event.open
          ? "Automatic work paused after repeated failures."
          : "The automatic-work circuit breaker was reset.",
        occurredAt: event.openedAt ?? record.createdAt,
        proposalId: null,
        reason: event.open ? "three-failures-in-24h" : null,
      });
    }
  }
  const deduplicated = new Map();
  for (const entry of output) deduplicated.set(entry.id, entry);
  return [...deduplicated.values()]
    .sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id));
}

function latestBackoffUntil(records, now) {
  return Math.max(0, ...(records ?? [])
    .filter((record) => record.kind === "audit-event"
      && record.payload?.actor === "self-evolve-scheduler"
      && record.payload?.details?.action === "work-failure"
      && Number.isSafeInteger(record.payload.details.backoffUntil)
      && record.payload.details.backoffUntil > now)
    .map((record) => record.payload.details.backoffUntil));
}

function rolloutSummary(records, health) {
  if (health.rollout) return health.rollout;
  const outcomes = new Map();
  for (const record of records ?? []) {
    const details = record.kind === "audit-event" ? record.payload?.details : null;
    if (details?.action !== "synthesis-outcome"
        || typeof details.outcomeId !== "string"
        || outcomes.has(details.outcomeId)
        || typeof details.success !== "boolean") continue;
    outcomes.set(details.outcomeId, details.success);
  }
  const synthesesObserved = outcomes.size;
  const successes = [...outcomes.values()].filter(Boolean).length;
  const minSynthesesObserved = Number.isSafeInteger(health.minSynthesesObserved) ? health.minSynthesesObserved : 10;
  const minSuccessRateBasisPoints = Number.isSafeInteger(health.minSuccessRateBasisPoints)
    ? health.minSuccessRateBasisPoints
    : 8_000;
  const successRateBasisPoints = synthesesObserved ? Math.floor((successes * 10_000) / synthesesObserved) : 0;
  return {
    ready: synthesesObserved >= minSynthesesObserved && successRateBasisPoints >= minSuccessRateBasisPoints,
    synthesesObserved,
    minSynthesesObserved,
    successRateBasisPoints,
    minSuccessRateBasisPoints,
  };
}

function dashboardBlockers(snapshot, health, breakerOpen, breakerEpoch) {
  const output = [];
  const add = (code, summary) => output.push({
    code,
    summary,
    destination: UI_DASHBOARD_BLOCKER_DESTINATIONS[code].dashboard,
  });
  const globalSettings = snapshot.settings.global;
  const consent = globalSettings.consent;
  if (health.corrupt === true) add("corrupt-state", "Stored state could not be validated.");
  if (health.hostSupported === false) add("unsupported-host", "This OpenCode host version is not supported.");
  if (health.stateRootReady === false) add("state-root", "The official OpenCode state root is not validated.");
  if (health.providerReady === false) add("provider", "Background analysis has no usable provider.");
  if (snapshot.settings.global.killSwitchActive || health.runtimeKillSwitch === true) {
    add("emergency-stop", "Emergency stop disables automatic provider and write authority.");
  }
  if (breakerOpen) {
    // H5-001/H5-002: surface the durable root-global breaker epoch detail so the
    // Activity/Errors blocker is actionable: shows the cross-process reason and
    // the authenticated reset path.
    const epochReason = breakerEpoch?.tripped && typeof breakerEpoch.reason === "string" && breakerEpoch.reason.length > 0
      ? breakerEpoch.reason
      : null;
    add(
      "circuit-breaker",
      epochReason
        ? `Automatic work paused after repeated failures (${epochReason}). Review failures in Activity, then reset with /self-evolve reset-breaker --confirm RESET SELF-EVOLVE BREAKER 0.3.0.`
        : "Repeated failures paused automatic work. Review failures in Activity, then reset with /self-evolve reset-breaker --confirm RESET SELF-EVOLVE BREAKER 0.3.0.",
    );
  }
  if (!globalSettings.automaticRecommendationsEnabled) {
    add("automatic-recommendations-off", "Automatic recommendations are off.");
  }
  if (snapshot.settings.repo.excluded) add("repository-excluded", "This project is excluded from automatic recommendations.");
  if (health.lifecycleEventHookInstalled === false) {
    add("restart-required", "Background analysis is awaiting an OpenCode restart before it can activate.");
  }
  if (Object.values(consent).some((allowed) => allowed !== true)) {
    add("observation-consent", "All three data permissions are required before automatic recommendations can run.");
  }
  const order = new Map(UI_DASHBOARD_BLOCKER_CODES.map((code, index) => [code, index]));
  return output
    .filter((item, index, values) => values.findIndex((candidate) => candidate.code === item.code) === index)
    .sort((left, right) => order.get(left.code) - order.get(right.code));
}

function dashboardAutomation({
  status,
  snapshot,
  health,
  breakerOpen,
  blockers,
  backoffUntil,
}) {
  let state;
  let reason = null;
  if (status.state === "terminal") state = "terminal";
  else if (status.state === "corrupt" || status.state === "unavailable") state = "corrupt";
  else if (snapshot.settings.global.killSwitchActive || health.runtimeKillSwitch === true) state = "emergency-stop";
  else if (breakerOpen) state = "circuit-breaker";
  else if (snapshot.settings.repo.excluded) state = "excluded";
  else if (!snapshot.settings.global.automaticRecommendationsEnabled) {
    state = "off";
    reason = "automatic-recommendations-off";
  }
  else if (blockers.length || status.state === "setup-required") state = "setup-required";
  else if ((health.inFlightCount ?? 0) > 0) state = "running";
  else if (backoffUntil > health.now) {
    state = "backoff";
    reason = "backoff";
  } else if (snapshot.usage.provider.remaining === 0 || snapshot.usage.synthesis.remaining === 0) {
    state = "budget";
    reason = snapshot.usage.provider.remaining === 0
      ? "passive-provider-budget-exhausted"
      : "synthesis-budget-exhausted";
  } else if (health.budgetStatus?.withinQuietPeriod === true) {
    state = "quiet-period";
    reason = "quiet-period";
  } else state = "ready";
  if (!UI_DASHBOARD_AUTOMATION_STATES.includes(state)) throw new Error("invalid-dashboard-automation-state");
  return { state, reason };
}

function buildDashboard(snapshot, {
  index,
  stateRootIdentity,
  now,
  status,
  breakerOpen,
  breakerEpoch,
  health,
  supportedCapabilities,
  dashboardCapabilities,
  operationGrants,
  expiresAt,
  hiddenProposalIds,
  dashboardVersion,
}) {
  const records = snapshot.records ?? [];
  const blockers = dashboardBlockers(snapshot, health, breakerOpen, breakerEpoch);
  const backoffUntil = latestBackoffUntil(records, now);
  const automation = dashboardAutomation({
    status,
    snapshot,
    health: { ...health, now },
    breakerOpen,
    blockers,
    backoffUntil,
  });
  const hideCriticPendingLink = (entry) => entry?.proposalId && hiddenProposalIds.has(entry.proposalId)
    ? { ...entry, proposalId: null }
    : entry;
  const activities = semanticActivity(records).map(hideCriticPendingLink);
  const boundedActivity = bounded(activities, UI_PROTOCOL_LIMITS.activityEntries);
  const lastCycleRecord = hideCriticPendingLink(
    [...records].reverse().map(cycleAuditValue).find(Boolean) ?? null,
  );
  const inFlightCount = Math.max(0, Math.min(1_000, Number.isSafeInteger(health.inFlightCount) ? health.inFlightCount : 0));
  const inFlightStartedAt = inFlightCount > 0 && Number.isSafeInteger(health.inFlightStartedAt)
    ? health.inFlightStartedAt
    : inFlightCount > 0 ? now : null;
  const nextEligibleAt = Math.max(
    0,
    backoffUntil,
    snapshot.usage.provider.remaining === 0 ? snapshot.usage.provider.resetAt ?? 0 : 0,
    snapshot.usage.synthesis.remaining === 0 ? snapshot.usage.synthesis.resetAt ?? 0 : 0,
    Number.isSafeInteger(health.nextEligibleAt) ? health.nextEligibleAt : 0,
  ) || null;
  const globalSettingsVersion = sha256(JSON.stringify({
    global: snapshot.settings.global,
    repo: snapshot.settings.repo,
    automationStamp: snapshot.settings.automationStamp,
  }));
  const globalRootPolicy = snapshot.settings.global.globalRootPolicy === null
    ? null
    : {
        roots: [...snapshot.settings.global.globalRootPolicy.roots]
          .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath))
          .map((root) => ({
            canonicalPath: root.canonicalPath,
            canUpdate: root.canUpdate,
            canCreate: root.canCreate,
          })),
        creationRootPath: snapshot.settings.global.globalRootPolicy.roots.find(
          (root) => root.rootId === snapshot.settings.global.globalRootPolicy.creationRootId,
        )?.canonicalPath ?? null,
        rootSetHash: snapshot.settings.global.globalRootPolicy.rootSetHash,
        updatedAt: snapshot.settings.global.globalRootPolicy.updatedAt,
      };
  const body = {
    dashboardVersion,
    projectFingerprint: snapshot.projectFingerprint,
    stateRootIdentity,
    generation: index.generation,
    indexHash: index.projectionHash,
    generatedAt: now,
    capabilities: dashboardCapabilities,
    automation,
    blockers,
    inFlight: {
      active: inFlightCount > 0,
      count: inFlightCount,
      stage: inFlightCount > 0 ? (health.inFlightStage ?? "pipeline") : null,
      startedAt: inFlightStartedAt,
    },
    lastCycle: dashboardVersion === 3 && lastCycleRecord !== null
      ? Object.fromEntries(Object.entries(lastCycleRecord).filter(([key]) => key !== "mode"))
      : lastCycleRecord,
    nextEligibleAt,
    usage: snapshot.usage,
    rollout: rolloutSummary(records, health),
    settings: {
      automaticRecommendationsEnabled: snapshot.settings.global.automaticRecommendationsEnabled,
      automationGeneration: snapshot.settings.automationStamp.generation,
      killSwitchActive: snapshot.settings.global.killSwitchActive || health.runtimeKillSwitch === true,
      repositoryExcluded: snapshot.settings.repo.excluded,
      consent: snapshot.settings.global.consent,
      approvedSkillFolderCount: snapshot.settings.global.allowedSkillRoots.length,
      collectionSuggestions: [...snapshot.settings.global.allowedSkillRoots].sort(),
      ...(dashboardVersion >= 2 ? {
        globalSettingsVersion,
        globalRootPolicy,
        globalRootPolicyConfirmation: globalRootPolicyConfirmation(globalSettingsVersion),
        globalRootPolicyAction: status.state === "ready"
          && dashboardCapabilities.includes(UI_ACTION_CAPABILITIES["replace-global-root-policy"])
          && operationGrants.get("\nreplace-global-root-policy")
          ? actionGrant(
              "replace-global-root-policy",
              operationGrants.get("\nreplace-global-root-policy"),
              expiresAt,
            )
          : null,
      } : {}),
    },
    retention: {
      observationsDays: snapshot.settings.global.retentionDays,
      operationalDays: dashboardVersion === 1 ? 90 : snapshot.settings.global.retentionDays * 3,
    },
    supportedControls: Object.entries(UI_ACTION_CAPABILITIES)
      .filter(([, capability]) => supportedCapabilities.includes(capability)
        || dashboardCapabilities.includes(capability))
      .map(([action]) => action)
      .sort(),
    activity: boundedActivity.included,
    overflow: { activity: boundedActivity.overflow },
  };
  return makeUiDashboard({ ...body, dashboardHash: hashUiProtocol("dashboard", body) }, {
    projectFingerprint: snapshot.projectFingerprint,
    stateRootIdentity,
    generation: index.generation,
    indexHash: index.projectionHash,
    now,
  });
}

function assertProjectionInput(snapshot, options) {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("projection-snapshot-required");
  if (!HASH_RE.test(String(snapshot.projectFingerprint ?? ""))) throw new TypeError("invalid-project-fingerprint");
  if (!HASH_RE.test(String(snapshot.generation ?? ""))) throw new TypeError("invalid-store-generation");
  if (!snapshot.settings?.global || !snapshot.settings?.repo) throw new TypeError("projection-settings-required");
  if (snapshot.settings.repo.projectFingerprint !== snapshot.projectFingerprint) throw new TypeError("projection-project-mismatch");
  if (!HASH_RE.test(String(options.stateRootIdentity ?? ""))) throw new TypeError("invalid-state-root-identity");
  if (!Number.isSafeInteger(options.now) || options.now < 0) throw new TypeError("invalid-projection-time");
}

export function buildUiProjection(snapshot, {
  stateRootIdentity,
  now = Date.now(),
  targetReader,
  inventory,
  health = {},
  capabilities = UI_CAPABILITIES,
  dashboardCapabilities = UI_DASHBOARD_CAPABILITIES,
  detailProposalIds = [],
} = {}) {
  const options = { stateRootIdentity, now };
  assertProjectionInput(snapshot, options);
  const supportedCapabilities = [...new Set(capabilities)].sort();
  const supportedDashboardCapabilities = [...new Set(dashboardCapabilities)].sort();
  const byKind = recordsByKind(snapshot);
  const latestProposals = latestPayloads(byKind.get("proposal"), (proposal) => proposal.id);
  const hiddenProposalIds = new Set([...latestProposals.values()]
    .filter((entry) => entry.payload.projectFingerprint === snapshot.projectFingerprint
      && entry.payload.state === "critic-pending")
    .map((entry) => entry.payload.id));
  const proposals = [...latestProposals.values()]
    .map((entry) => entry.payload)
    .filter((proposal) => proposal.projectFingerprint === snapshot.projectFingerprint
      && REVIEWABLE_STATES.has(proposal.state)
      && sanitizeProposalId(proposal.id) === proposal.id
      && !PRIVATE_ID_RE.test(proposal.skillTarget.relativePath))
    .sort((left, right) => left.id.localeCompare(right.id));
  const firstTargets = readTargets(proposals, targetReader);
  const generation = sha256(`self-evolve-ui-projection-generation-v1\n${canonicalUiJson({
    storeGeneration: snapshot.generation,
    targets: proposals.map((proposal) => targetDescriptor(proposal, firstTargets.get(proposal.id))),
  })}`);
  const auditRecords = byKind.get("audit-event") ?? [];
  const auditByProposal = new Map();
  for (const record of auditRecords) {
    const proposalId = record.payload?.proposalId;
    if (!proposalId) continue;
    const grouped = auditByProposal.get(proposalId) ?? [];
    grouped.push(record);
    auditByProposal.set(proposalId, grouped);
  }
  const recordBreakerOpen = (byKind.get("circuit-breaker") ?? []).at(-1)?.payload?.open === true;
  // H5-001: the durable root-global breaker epoch is the cross-process truth.
  // Combine the record-derived state with the epoch health so the projection
  // reflects peer trip/reset writes without restart.
  const breakerEpochHealth = health?.breakerEpoch && typeof health.breakerEpoch === "object" ? health.breakerEpoch : null;
  const breakerOpen = recordBreakerOpen || breakerEpochHealth?.tripped === true;
  const breakerEpoch = breakerEpochHealth
    ? {
        tripped: breakerEpochHealth.tripped === true,
        generation: Number.isSafeInteger(breakerEpochHealth.generation) ? breakerEpochHealth.generation : null,
        trippedAt: Number.isSafeInteger(breakerEpochHealth.trippedAt) ? breakerEpochHealth.trippedAt : null,
        reason: typeof breakerEpochHealth.reason === "string" ? breakerEpochHealth.reason : null,
        resetAvailable: breakerEpochHealth.resetAvailable === true && breakerEpochHealth.tripped === true,
      }
    : null;
  // Local proposal details are legacy read-only compatibility. The v0.4
  // dashboard and operations expose only the binary automation preference.
  // Retained local proposal details still call the v0.3 explicit-decision
  // predicate. Fix that compatibility input to its actionable branch: the
  // v0.4 automation preference never grants or suppresses explicit actions.
  const legacyDetailMode = "auto";
  const status = statusFrom(snapshot.settings, health, breakerOpen);
  const issuedAt = now;
  const expiresAt = now + UI_PROTOCOL_LIMITS.projectionTtlMs;
  const operationGrants = uiOperationGrants(auditRecords, {
    projectFingerprint: snapshot.projectFingerprint,
    stateRootIdentity,
    generation,
    now,
    capabilities: [...supportedCapabilities, ...supportedDashboardCapabilities],
  });
  const operations = operationsFor(auditRecords);
  const detailCandidates = [];

  for (const proposal of proposals) {
    const proposalAudits = auditByProposal.get(proposal.id) ?? [];
    const target = firstTargets.get(proposal.id);
    const appliedAudit = latestAppliedAudit(proposal, proposalAudits);
    const integrity = combineIntegrity(
      targetIntegrity(proposal, target, appliedAudit),
      inventoryIntegrity(proposal, target, inventory, snapshot.settings.global.allowedSkillRoots),
    );
    const content = decodeProposalContent(proposal, byKind.get("proposal-content"));
    const risk = riskFor(proposal, integrity, content);
    const auditValues = auditFor(proposal, proposalAudits);
    const boundedAudit = bounded(auditValues, UI_PROTOCOL_LIMITS.auditEntries);
    const evidenceValues = evidenceFor(proposal, byKind.get("evidence-cluster"));
    const boundedEvidence = bounded(evidenceValues, UI_PROTOCOL_LIMITS.evidenceEntries);
    const legacyGrant = matchingLegacyGrant(proposal, proposalAudits, now);
    const allowedActions = detailAllowedActions({
      proposal,
      effectiveMode: legacyDetailMode,
      integrity,
      content,
      appliedAudit,
      legacyGrant,
      operationGrants,
      expiresAt,
      authorityReady: status.state === "ready",
      capabilities: supportedCapabilities,
    });
    const boundedActions = bounded(allowedActions, UI_PROTOCOL_LIMITS.allowedActions);
    const revision = detailRevision(proposal.id, byKind);
    const rationale = containsPrivateMaterial(proposal.rationaleText)
      ? "Rationale unavailable after privacy validation."
      : safeText(proposal.rationaleText, "Rationale unavailable.", UI_PROTOCOL_LIMITS.rationaleBytes);
    const body = {
      projectionVersion: UI_PROJECTION_VERSION,
      projectFingerprint: snapshot.projectFingerprint,
      stateRootIdentity,
      generation,
      proposalId: proposal.id,
      revision,
      issuedAt,
      expiresAt,
      summary: {
        state: proposal.state,
        target: {
          relativePath: proposal.skillTarget.relativePath,
          currentHash: proposal.skillTarget.currentHash,
          proposedContentHash: proposal.proposedContentHash,
        },
        effectiveMode: legacyDetailMode,
        rationale,
        risk,
        criticScoreBasisPoints: Math.max(0, Math.min(10_000, Math.round(proposal.criticScore * 10_000))),
        criticPassed: proposal.criticPassed,
        validDeterministic: proposal.validDeterministic,
        injectionFlagged: proposal.injectionFlagged,
        tokenImpact: {
          estimatedTokens: content.ok ? Math.ceil(Buffer.byteLength(content.content, "utf8") / 4) : 0,
          budgetTokens: effectiveTokensPerSynthesis(mergedBudgets(snapshot.settings).tokensPerSynthesis),
        },
        eligibility: eligibilityFor(proposal, byKind.get("eligibility-explanation")),
        rollback: rollbackFor(proposal, target, appliedAudit),
        operation: latestDetailOperation(proposal.id, operations, proposalAudits),
      },
      diff: makeDiff(proposal, target, content, integrity),
      evidence: boundedEvidence.included,
      audit: boundedAudit.included,
      allowedActions: boundedActions.included,
      overflow: {
        evidence: boundedEvidence.overflow,
        audit: boundedAudit.overflow,
        allowedActions: boundedActions.overflow,
      },
    };
    const detail = { ...body, detailHash: hashUiProtocol("review-detail", body) };
    const clean = makeUiReviewDetail(detail, {
      projectFingerprint: snapshot.projectFingerprint,
      stateRootIdentity,
      generation,
      detailRevision: revision,
      detailHash: detail.detailHash,
      now,
      supportedCapabilities,
    });
    detailCandidates.push({
      proposal,
      detail: clean,
      updatedAt: Math.max(
        latestProposals.get(proposal.id)?.createdAt ?? proposal.synthesizedAt,
        ...auditValues.map((event) => event.timestamp),
      ),
      attention: attentionFor(risk),
    });
  }

  const secondTargets = readTargets(proposals, targetReader);
  assertTargetsStable(proposals, firstTargets, secondTargets);
  const attentionRank = { critical: 0, warning: 1, normal: 2 };
  detailCandidates.sort((left, right) => attentionRank[left.attention] - attentionRank[right.attention]
    || right.updatedAt - left.updatedAt || left.proposal.id.localeCompare(right.proposal.id));
  const reviews = detailCandidates.map((candidate) => ({
    proposalId: candidate.proposal.id,
    state: candidate.proposal.state,
    target: candidate.proposal.skillTarget.relativePath,
    attention: candidate.attention,
    updatedAt: candidate.updatedAt,
    detailRevision: candidate.detail.revision,
    detailHash: candidate.detail.detailHash,
  }));
  const boundedReviews = bounded(reviews, UI_PROTOCOL_LIMITS.reviewIndexEntries);
  const boundedOperations = bounded(operations, UI_PROTOCOL_LIMITS.operationEntries);
  const allowedActions = indexAllowedActions(operationGrants, expiresAt, status.state);
  const boundedIndexActions = bounded(allowedActions, UI_PROTOCOL_LIMITS.allowedActions);
  const indexBody = {
    projectionVersion: UI_PROJECTION_VERSION,
    projectFingerprint: snapshot.projectFingerprint,
    stateRootIdentity,
    generation,
    issuedAt,
    expiresAt,
    capabilities: supportedCapabilities,
    status,
    budgets: mergedBudgets(snapshot.settings),
    reviews: boundedReviews.included,
    operations: boundedOperations.included,
    allowedActions: boundedIndexActions.included,
    overflow: {
      reviews: boundedReviews.overflow,
      operations: boundedOperations.overflow,
      allowedActions: boundedIndexActions.overflow,
    },
  };
  const rawIndex = { ...indexBody, projectionHash: hashUiProtocol("projection-index", indexBody) };
  const index = makeUiProjectionIndex(rawIndex, {
    projectFingerprint: snapshot.projectFingerprint,
    stateRootIdentity,
    generation,
    now,
    supportedCapabilities,
  });
  const dashboardOptions = {
    index,
    stateRootIdentity,
    now,
    status,
    breakerOpen,
    breakerEpoch,
    health,
    supportedCapabilities,
    dashboardCapabilities: supportedDashboardCapabilities,
    operationGrants,
    expiresAt,
    hiddenProposalIds,
  };
  const dashboard = buildDashboard(snapshot, {
    ...dashboardOptions,
    dashboardVersion: UI_DASHBOARD_VERSION,
  });
  const requested = [...new Set(detailProposalIds)].slice(0, UI_PROTOCOL_LIMITS.residentDetails);
  const detailById = new Map(detailCandidates.map((candidate) => [candidate.proposal.id, candidate.detail]));
  const publicationDetails = boundedReviews.included.map((review) => detailById.get(review.proposalId));
  const details = requested.map((proposalId) => detailById.get(proposalId)).filter(Boolean);
  let footprint;
  const unavailableDetailIds = requested.filter((proposalId) => (
    !hiddenProposalIds.has(proposalId) && !detailById.has(proposalId)
  ));
  while (true) {
    try {
      footprint = assertUiProjectionFootprint(index, details, {
        projectFingerprint: snapshot.projectFingerprint,
        stateRootIdentity,
        generation,
        now,
        supportedCapabilities,
      });
      break;
    } catch (error) {
      if (error?.message !== "total-projection-footprint-exceeded" || !details.length) throw error;
      unavailableDetailIds.push(details.pop().proposalId);
    }
  }
  return deepFreeze({
    generation,
    index: footprint.index,
    dashboard,
    publicationDetails,
    details: footprint.details,
    unavailableDetailIds: unavailableDetailIds.sort(),
  });
}

const GLOBAL_PROJECTED_STATES = new Set(["pending", "approved", "applied", "undo-approved", "failed-closed"]);

function normalizeGlobalTargetRead(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { available: false, exists: null, hash: null, content: null };
  }
  const exists = value.exists === true;
  const content = typeof value.content === "string"
    ? value.content
    : Buffer.isBuffer(value.content) ? value.content.toString("utf8") : null;
  const calculated = content === null ? null : sha256(content);
  const hash = HASH_RE.test(String(value.hash ?? "")) ? String(value.hash) : calculated;
  if ((exists && (content === null || hash !== calculated)) || (!exists && content !== null)) {
    return { available: false, exists, hash: null, content: null };
  }
  return { available: true, exists, hash: exists ? hash : null, content };
}

function globalTargetRead(recommendation, targetReader) {
  try { return normalizeGlobalTargetRead(targetReader?.(recommendation)); }
  catch { return { available: false, exists: null, hash: null, content: null }; }
}

function globalTargetFresh(recommendation, target) {
  const expected = recommendation.state === "applied"
    ? recommendation.proposedContentHash
    : recommendation.targetBinding.currentHash;
  if (!target.available || (target.content !== null && containsPrivateMaterial(target.content))) return false;
  return expected === "must-not-exist"
    ? target.exists === false
    : target.exists === true && target.hash === expected;
}

function globalAvailableActions(recommendation, { contentValid, targetFresh, actionAuthority }) {
  const baseReason = (action) => actionAuthority[action].allowed ? null : actionAuthority[action].reason;
  const reasons = {
    apply: "action-state-mismatch",
    reject: "action-state-mismatch",
    undo: "action-state-mismatch",
  };
  if (recommendation.state === "pending") {
    reasons.apply = baseReason("apply")
      ?? (!contentValid ? "recommendation-content-invalid" : null)
      ?? (!targetFresh ? "target-not-fresh" : null)
      ?? (!recommendation.criticPassed || !recommendation.validDeterministic ? "release-gates-failed" : null);
    reasons.reject = baseReason("reject");
  } else if (recommendation.state === "superseded") {
    reasons.reject = baseReason("reject");
  } else if (recommendation.state === "applied") {
    reasons.undo = baseReason("undo") ?? (!targetFresh ? "target-not-fresh" : null);
  }
  return {
    actions: ["apply", "reject", "undo"].filter((action) => reasons[action] === null),
    reasons,
  };
}

function globalProjectedDiff(recommendation, target, content, contentValid, targetFresh) {
  if (!contentValid || !targetFresh || (target.content !== null && containsPrivateMaterial(target.content))) {
    return { kind: "unavailable", lines: [], overflow: makeUiOverflowMarker(0) };
  }
  const source = rawDiffLines(
    recommendation.targetBinding.relativePath,
    target.content ?? "",
    content,
    recommendation.targetBinding.currentHash === "must-not-exist",
  );
  const included = [];
  let bytes = 0;
  for (const line of source) {
    const width = Buffer.byteLength(line, "utf8");
    if (included.length >= GLOBAL_PROTOCOL_LIMITS.diffLines || bytes + width > GLOBAL_PROTOCOL_LIMITS.diffBytes) break;
    included.push(line);
    bytes += width;
  }
  const omitted = source.slice(included.length);
  return {
    kind: recommendation.targetBinding.currentHash === "must-not-exist" ? "new-file" : "unified",
    lines: included,
    overflow: overflowMarker(
      included.length,
      omitted,
      included.length >= GLOBAL_PROTOCOL_LIMITS.diffLines ? "item-limit" : "byte-limit",
    ),
  };
}

function globalProjectionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("global-projection-snapshot-required");
  for (const field of ["recommendations", "supportSets", "candidates", "audits"]) {
    if (!Array.isArray(value[field])) throw new TypeError(`global-projection-${field}-required`);
  }
  if (!value.contentByRecommendation || typeof value.contentByRecommendation !== "object"
      || Array.isArray(value.contentByRecommendation)) throw new TypeError("global-projection-content-required");
  return value;
}

function globalGeneration(snapshot, stateRootIdentity, issuedAt, targets) {
  return sha256(`self-evolve-global-projection-generation-v1\n${canonicalUiJson({
    stateRootIdentity,
    issuedAt,
    recommendations: snapshot.recommendations.map((recommendation) => ({
      recommendationId: recommendation.recommendationId,
      supportSetHash: recommendation.supportSetHash,
      targetBindingHash: recommendation.targetBinding?.bindingHash,
      proposedContentHash: recommendation.proposedContentHash,
      state: recommendation.state,
      decisionVersion: recommendation.decisionVersion,
      target: targets.get(recommendation.recommendationId),
    })).sort((left, right) => left.recommendationId.localeCompare(right.recommendationId)),
  })}`);
}

function globalProjectionOverflow(included, omitted) {
  return overflowMarker(included.length, omitted, omitted.length ? "item-limit" : "none");
}

export function buildGlobalRecommendationProjection(snapshotValue, {
  stateRootIdentity,
  now = Date.now(),
  targetReader,
  detailRecommendationIds,
  capabilities = GLOBAL_CAPABILITIES,
  writeAuthorityReady = true,
  actionAuthority = null,
  nonceFactory = randomUUID,
} = {}) {
  const snapshot = globalProjectionSnapshot(snapshotValue);
  if (!HASH_RE.test(String(stateRootIdentity ?? ""))) throw new TypeError("invalid-state-root-identity");
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid-global-projection-time");
  if (typeof nonceFactory !== "function") throw new TypeError("global-projection-nonce-factory-required");
  if (typeof writeAuthorityReady !== "boolean") throw new TypeError("invalid-global-write-authority-state");
  const normalizedActionAuthority = actionAuthority ?? Object.fromEntries(["apply", "reject", "undo"].map((action) => [
    action,
    { allowed: writeAuthorityReady, reason: writeAuthorityReady ? null : "write-authority-unavailable" },
  ]));
  if (!normalizedActionAuthority || typeof normalizedActionAuthority !== "object"
      || Object.keys(normalizedActionAuthority).sort().join(",") !== "apply,reject,undo"
      || Object.entries(normalizedActionAuthority).some(([, value]) => !value || typeof value.allowed !== "boolean"
        || (value.allowed ? value.reason !== null : typeof value.reason !== "string"))) {
    throw new TypeError("invalid-global-action-authority-state");
  }
  const supportedCapabilities = [...new Set(capabilities)].sort();
  const supportByHash = new Map(snapshot.supportSets.map((support) => [support.supportSetHash, support]));
  const candidateById = new Map(snapshot.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const auditByRecommendation = new Map();
  for (const audit of snapshot.audits) {
    if (!audit?.recommendationId) continue;
    const values = auditByRecommendation.get(audit.recommendationId) ?? [];
    values.push(audit);
    auditByRecommendation.set(audit.recommendationId, values);
  }
  const recommendations = snapshot.recommendations
    .filter((recommendation) => GLOBAL_PROJECTED_STATES.has(recommendation?.state))
    .sort((left, right) => left.recommendationId.localeCompare(right.recommendationId));
  const targetReads = new Map(recommendations.map((recommendation) => [
    recommendation.recommendationId,
    globalTargetRead(recommendation, targetReader),
  ]));
  const generation = globalGeneration(
    { ...snapshot, recommendations },
    stateRootIdentity,
    now,
    new Map([...targetReads].map(([id, target]) => [id, { available: target.available, exists: target.exists, hash: target.hash }])) ,
  );
  const expiresAt = now + GLOBAL_PROTOCOL_LIMITS.projectionTtlMs;
  const detailCandidates = [];
  for (const recommendation of recommendations) {
    const support = supportByHash.get(recommendation.supportSetHash);
    const candidate = candidateById.get(recommendation.candidateId);
    if (!support || support.candidateId !== recommendation.candidateId
        || !candidate || candidate.supportSetHash !== recommendation.supportSetHash) continue;
    const content = snapshot.contentByRecommendation[recommendation.recommendationId];
    const contentValid = typeof content === "string"
      && sha256(content) === recommendation.proposedContentHash
      && !containsPrivateMaterial(content);
    const target = targetReads.get(recommendation.recommendationId);
    const targetFresh = globalTargetFresh(recommendation, target);
    const actionState = globalAvailableActions(recommendation, {
      contentValid,
      targetFresh,
      actionAuthority: normalizedActionAuthority,
    });
    const availableActions = actionState.actions;
    const recommendationVersion = recommendation.decisionVersion + 1;
    const tier = candidate.eligibilityRoute === "distributed" ? "distributed" : "single-domain";
    const updatedAt = Math.max(
      recommendation.synthesizedAt,
      candidate.updatedAt ?? recommendation.synthesizedAt,
      ...(auditByRecommendation.get(recommendation.recommendationId) ?? [])
        .map((audit) => audit.timestamp)
        .filter(Number.isSafeInteger),
    );
    const detailBody = {
      projectionVersion: GLOBAL_PROJECTION_VERSION,
      stateRootIdentity,
      generation,
      recommendationId: recommendation.recommendationId,
      recommendationVersion,
      supportSetHash: recommendation.supportSetHash,
      targetBindingHash: recommendation.targetBinding.bindingHash,
      targetHash: recommendation.state === "applied"
        ? recommendation.proposedContentHash
        : recommendation.targetBinding.currentHash,
      proposedContentHash: recommendation.proposedContentHash,
      priorState: recommendation.state,
      issuedAt: now,
      expiresAt,
      target: {
        kind: recommendation.targetBinding.targetKind,
        label: recommendation.targetBinding.logicalName,
      },
      support: {
        tier,
        independentDomainCount: candidate.independentDomainCount,
        independentIncidentCount: candidate.independentIncidentCount,
        occurrenceCount: candidate.occurrenceCount,
        firstSeenDay: support.firstSeenDay,
        lastSeenDay: support.lastSeenDay,
      },
      safety: {
        criticScoreBasisPoints: Math.max(0, Math.min(10_000, Math.round(recommendation.criticScore * 10_000))),
        criticPassed: recommendation.criticPassed === true,
        validDeterministic: recommendation.validDeterministic === true,
      },
      generality: {
        passed: true,
        basis: "deterministic-generality-gate-v1",
      },
      rationale: containsPrivateMaterial(recommendation.rationaleText)
        ? "Rationale unavailable after privacy validation."
        : safeText(recommendation.rationaleText, "Rationale unavailable.", GLOBAL_PROTOCOL_LIMITS.rationaleBytes),
      diff: globalProjectedDiff(recommendation, target, content, contentValid, targetFresh),
      evidenceSummary: [
        { kind: "independent-domains", count: candidate.independentDomainCount },
        { kind: "independent-incidents", count: candidate.independentIncidentCount },
        { kind: "occurrences", count: candidate.occurrenceCount },
      ],
      availableActions,
      actionReasons: actionState.reasons,
    };
    const detailValue = { ...detailBody, detailHash: hashGlobalProtocol("recommendation-detail", detailBody) };
    const detail = makeGlobalRecommendationDetail(detailValue, {
      stateRootIdentity,
      generation,
      recommendationId: recommendation.recommendationId,
      recommendationVersion,
      detailHash: detailValue.detailHash,
      now,
    });
    detailCandidates.push({
      recommendation,
      support,
      candidate,
      detail,
      updatedAt,
      indexEntry: {
        recommendationId: recommendation.recommendationId,
        recommendationVersion,
        supportSetHash: recommendation.supportSetHash,
        state: recommendation.state,
        target: detail.target,
        support: {
          tier,
          independentDomainCount: candidate.independentDomainCount,
          independentIncidentCount: candidate.independentIncidentCount,
          occurrenceCount: candidate.occurrenceCount,
        },
        dates: {
          firstSeenDay: support.firstSeenDay,
          lastSeenDay: support.lastSeenDay,
          synthesizedAt: recommendation.synthesizedAt,
          updatedAt,
        },
        safety: detail.safety,
        availableActions,
        detailHash: detail.detailHash,
      },
    });
  }
  detailCandidates.sort((left, right) => right.updatedAt - left.updatedAt
    || left.recommendation.recommendationId.localeCompare(right.recommendation.recommendationId));
  const sourceCandidates = detailCandidates;
  let includedCandidates = sourceCandidates.slice(0, GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries);
  let index;
  while (true) {
    const omittedCandidates = sourceCandidates.slice(includedCandidates.length);
    const indexBody = {
      projectionVersion: GLOBAL_PROJECTION_VERSION,
      stateRootIdentity,
      generation,
      issuedAt: now,
      expiresAt,
      capabilities: supportedCapabilities,
      recommendations: includedCandidates.map((candidate) => candidate.indexEntry),
      overflow: globalProjectionOverflow(
        includedCandidates.map((candidate) => candidate.indexEntry),
        omittedCandidates.map((candidate) => candidate.indexEntry),
      ),
    };
    const indexValue = { ...indexBody, indexHash: hashGlobalProtocol("recommendation-index", indexBody) };
    try {
      index = makeGlobalRecommendationIndex(indexValue, {
        stateRootIdentity,
        generation,
        now,
        supportedCapabilities,
      });
      break;
    } catch (error) {
      if (error?.message !== "global-index-footprint-exceeded" || includedCandidates.length === 0) throw error;
      includedCandidates = includedCandidates.slice(0, -1);
    }
  }
  const includedById = new Map(includedCandidates.map((candidate) => [candidate.recommendation.recommendationId, candidate]));
  const requestedIds = detailRecommendationIds === undefined
    ? includedCandidates.slice(0, GLOBAL_PROTOCOL_LIMITS.residentDetails).map((candidate) => candidate.recommendation.recommendationId)
    : detailRecommendationIds;
  if (!Array.isArray(requestedIds) || requestedIds.length > GLOBAL_PROTOCOL_LIMITS.residentDetails
      || new Set(requestedIds).size !== requestedIds.length) throw new TypeError("global-resident-details-out-of-bounds");
  const unavailableDetailIds = requestedIds.filter((id) => !includedById.has(id));
  const details = requestedIds.map((id) => includedById.get(id)?.detail).filter(Boolean);
  while (details.length && Buffer.byteLength(canonicalUiJson(index), "utf8")
      + details.reduce((total, detail) => total + Buffer.byteLength(canonicalUiJson(detail), "utf8"), 0)
      > GLOBAL_PROTOCOL_LIMITS.totalProjectionBytes) {
    unavailableDetailIds.push(details.pop().recommendationId);
  }
  const grants = [];
  for (const detail of details) {
    for (const action of detail.availableActions) {
      const body = {
        grantVersion: 1,
        capability: "global-action-grant-v1",
        stateRootIdentity,
        generation,
        indexHash: index.indexHash,
        detailHash: detail.detailHash,
        recommendationId: detail.recommendationId,
        recommendationVersion: detail.recommendationVersion,
        supportSetHash: detail.supportSetHash,
        targetBindingHash: detail.targetBindingHash,
        targetHash: detail.targetHash,
        proposedContentHash: detail.proposedContentHash,
        priorState: detail.priorState,
        action,
        nonce: nonceFactory(),
        issuedAt: now,
        expiresAt: Math.min(expiresAt, now + GLOBAL_PROTOCOL_LIMITS.operationTtlMs),
      };
      grants.push(makeGlobalActionGrant({ ...body, grantHash: hashGlobalProtocol("action-grant", body) }, {
        stateRootIdentity,
        generation,
        indexHash: index.indexHash,
        detailHash: detail.detailHash,
        now,
      }));
    }
  }
  return deepFreeze({
    generation,
    index,
    details,
    grants: grants.sort((left, right) => left.recommendationId.localeCompare(right.recommendationId)
      || left.action.localeCompare(right.action)),
    unavailableDetailIds: unavailableDetailIds.sort(),
    bytes: Buffer.byteLength(canonicalUiJson(index), "utf8")
      + details.reduce((total, detail) => total + Buffer.byteLength(canonicalUiJson(detail), "utf8"), 0),
  });
}

export function buildProjectParticipationSidecars(snapshotValue, {
  projectFingerprint,
  stateRootIdentity,
  now = Date.now(),
} = {}) {
  if (!snapshotValue || typeof snapshotValue !== "object" || Array.isArray(snapshotValue)
      || !Array.isArray(snapshotValue.recommendations) || !Array.isArray(snapshotValue.supportSets)
      || !Array.isArray(snapshotValue.contributionLinks)) throw new TypeError("project-participation-snapshot-required");
  if (!HASH_RE.test(String(projectFingerprint ?? ""))) throw new TypeError("invalid-project-fingerprint");
  if (!HASH_RE.test(String(stateRootIdentity ?? ""))) throw new TypeError("invalid-state-root-identity");
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid-participation-time");
  const index = snapshotValue.index;
  if (!index || index.stateRootIdentity !== stateRootIdentity || index.expiresAt <= now) {
    throw new Error("stale-global-index");
  }
  const recommendationById = new Map(snapshotValue.recommendations.map((recommendation) => [
    recommendation.recommendationId,
    recommendation,
  ]));
  const supportByHash = new Map(snapshotValue.supportSets.map((support) => [support.supportSetHash, support]));
  const activeContributionIds = new Set(snapshotValue.contributionLinks
    .filter((link) => link?.state === "active")
    .map((link) => link.contributionId));
  return deepFreeze(index.recommendations.map((entry) => {
    const recommendation = recommendationById.get(entry.recommendationId);
    const support = supportByHash.get(recommendation?.supportSetHash);
    if (!recommendation || !support || support.supportSetHash !== recommendation.supportSetHash) {
      throw new Error("participation-support-unavailable");
    }
    const body = {
      participationVersion: PROJECT_PARTICIPATION_VERSION,
      projectFingerprint,
      stateRootIdentity,
      generation: index.generation,
      indexHash: index.indexHash,
      recommendationId: recommendation.recommendationId,
      supportSetHash: support.supportSetHash,
      currentProjectContributed: support.contributionIds.some((id) => activeContributionIds.has(id)),
      issuedAt: index.issuedAt,
      expiresAt: index.expiresAt,
    };
    return makeProjectParticipationSidecar({
      ...body,
      participationHash: hashGlobalProtocol("project-participation", body),
    }, {
      projectFingerprint,
      stateRootIdentity,
      generation: index.generation,
      indexHash: index.indexHash,
      recommendationId: recommendation.recommendationId,
      supportSetHash: support.supportSetHash,
      now,
    });
  }));
}
