import { createHash } from "node:crypto";
import { scanForSecretCanaries, scanForUnsafeContent } from "./self-evolve-inventory.js";
import { deepFreeze, resolveMode } from "./self-evolve-schemas.js";
import {
  UI_ACTION_CAPABILITIES,
  UI_CAPABILITIES,
  UI_DASHBOARD_CAPABILITIES,
  UI_DASHBOARD_AUTOMATION_STATES,
  UI_DASHBOARD_BLOCKER_CODES,
  UI_DASHBOARD_OUTCOMES,
  UI_DASHBOARD_REASON_CODES,
  UI_DASHBOARD_VERSION,
  UI_PROJECTION_VERSION,
  UI_PROTOCOL_LIMITS,
  assertUiProjectionFootprint,
  canonicalUiJson,
  hashUiProtocol,
  makeUiDashboard,
  makeUiOverflowMarker,
  makeUiProjectionIndex,
  makeUiReviewDetail,
} from "./self-evolve-ui-protocol.js";

const REVIEWABLE_STATES = new Set(["critic-pending", "pending", "approved", "applied", "failed-closed"]);
const HASH_RE = /^[a-f0-9]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const REASON_CODE_RE = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const CHECK_NAME_RE = /^[A-Za-z][A-Za-z0-9.-]{0,63}$/u;
const PRIVATE_ID_RE = /\b(?:msg|message|ses|session)_[A-Za-z0-9_-]{4,}\b/u;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const MAX_DETAIL_REVISION = 1_000_000;
const CYCLE_OUTCOMES = new Set(UI_DASHBOARD_OUTCOMES.slice(0, 9));
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
  return truncateUtf8(clean || fallback, maxBytes);
}

function containsPrivateMaterial(value) {
  const source = String(value ?? "");
  return PRIVATE_ID_RE.test(source)
    || scanForSecretCanaries(source).flagged
    || scanForUnsafeContent(source).flagged;
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

function statusFrom(settings, health, breakerOpen, effectiveMode) {
  const backgroundRestartRequired = health.passiveEventHookInstalled === false && effectiveMode !== "manual";
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
    storedMode: settings.global.mode,
    effectiveMode,
    paused: settings.global.paused,
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
    "set-kill-switch",
    "set-paused",
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
  const fields = [
    "action", "outcome", "triggerClass", "mode", "observationCount",
    "eligibilityCount", "occurredAt", "reason",
  ];
  if (record?.kind !== "audit-event"
      || event?.kind !== "decision"
      || event.actor !== "self-evolve-integration"
      || !exactFieldSet(details, fields)
      || details.action !== "cycle-outcome"
      || !CYCLE_OUTCOMES.has(details.outcome)
      || !["manual", "auto", "yolo"].includes(details.mode)
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
    mode: details.mode,
    observationCount: details.observationCount,
    eligibilityCount: details.eligibilityCount,
    proposalId: typeof event.proposalId === "string"
      && ID_RE.test(event.proposalId)
      && !PRIVATE_ID_RE.test(event.proposalId)
      ? event.proposalId
      : null,
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
        proposalId: typeof event.proposalId === "string"
          && ID_RE.test(event.proposalId)
          && !PRIVATE_ID_RE.test(event.proposalId)
          ? event.proposalId
          : null,
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
        proposalId: typeof event.proposalId === "string" && ID_RE.test(event.proposalId) ? event.proposalId : null,
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
        proposalId: typeof event.proposalId === "string"
          && ID_RE.test(event.proposalId)
          && !PRIVATE_ID_RE.test(event.proposalId)
          ? event.proposalId
          : null,
        reason: null,
      });
      continue;
    }
    if (record?.kind === "audit-event"
        && event?.kind === "mode-change"
        && ["pause", "resume", "exclude", "include"].includes(event.details?.action)) {
      const mapping = {
        pause: ["paused", "Automatic work was paused.", "paused"],
        resume: ["resumed", "Automatic work was resumed.", null],
        exclude: ["project-excluded", "This project was excluded from automatic work.", "repository-excluded"],
        include: ["project-included", "This project was included in automatic work.", null],
      };
      const [outcome, summary, reason] = mapping[event.details.action];
      output.push({
        id: event.id,
        category: "system",
        audience: "default",
        outcome,
        summary,
        occurredAt: event.timestamp,
        proposalId: null,
        reason,
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
        proposalId: typeof event.proposalId === "string" && ID_RE.test(event.proposalId) ? event.proposalId : null,
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

function dashboardBlockers(snapshot, health, breakerOpen, effectiveMode) {
  const output = [];
  const add = (code, summary, destination = "settings") => output.push({ code, summary, destination });
  const globalSettings = snapshot.settings.global;
  const consent = globalSettings.consent;
  const firstRun = effectiveMode === "manual"
    && globalSettings.mode === "manual"
    && globalSettings.createdAt === globalSettings.updatedAt
    && consent.passiveCalls === false
    && consent.durableObservations === false
    && consent.sanitizedExcerpts === false
    && consent.crossRepoAggregation === false;
  if (health.corrupt === true) add("corrupt-state", "Stored state could not be validated.", "activity-errors");
  if (health.hostSupported === false) add("unsupported-host", "This OpenCode host version is not supported.");
  if (health.stateRootReady === false) add("state-root", "The official OpenCode state root is not validated.");
  if (health.providerReady === false) add("provider", "Background analysis has no usable provider.");
  if (snapshot.settings.global.killSwitchActive || health.runtimeKillSwitch === true) {
    add("emergency-stop", "Emergency stop disables automatic provider and write authority.");
  }
  if (breakerOpen) add("circuit-breaker", "Repeated failures paused automatic work.", "activity-errors");
  if (snapshot.settings.global.paused) add("paused", "Automatic work is paused.", "home");
  if (snapshot.settings.repo.excluded) add("repository-excluded", "This project is excluded from automatic work.");
  if (firstRun) add("first-run", "Automatic recommendations have not been set up yet.", "home");
  if (health.passiveEventHookInstalled === false && effectiveMode !== "manual") {
    add("restart-required", "Background analysis is awaiting an OpenCode restart before it can activate.");
  }
  if (effectiveMode !== "manual") {
    if (!snapshot.settings.global.consent.passiveCalls) add("passive-consent", "Background AI analysis is not allowed.");
    if (!snapshot.settings.global.consent.durableObservations) add("observation-consent", "Saved structured patterns are not allowed.");
  }
  if (effectiveMode === "yolo" && !snapshot.settings.global.allowedSkillRoots.length) {
    add("approved-skill-folders", "No approved skill folder is configured.");
  }
  const rollout = rolloutSummary(snapshot.records, health);
  if (effectiveMode === "yolo" && !rollout.ready) add("yolo-rollout", "Automatic apply rollout evidence is not ready.");
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
  effectiveMode,
  blockers,
  backoffUntil,
}) {
  let state;
  let reason = null;
  if (status.state === "terminal") state = "terminal";
  else if (status.state === "corrupt" || status.state === "unavailable") state = "corrupt";
  else if (snapshot.settings.global.killSwitchActive || health.runtimeKillSwitch === true) state = "emergency-stop";
  else if (breakerOpen) state = "circuit-breaker";
  else if (snapshot.settings.global.paused) state = "paused";
  else if (snapshot.settings.repo.excluded) state = "excluded";
  else if (effectiveMode === "manual") state = "on-demand";
  else if (blockers.length || status.state === "setup-required") state = "setup-required";
  else if ((health.inFlightCount ?? 0) > 0) state = "running";
  else if (backoffUntil > health.now) {
    state = "backoff";
    reason = "backoff";
  } else if (snapshot.usage.passive.remaining === 0 || snapshot.usage.synthesis.remaining === 0) {
    state = "budget";
    reason = snapshot.usage.passive.remaining === 0
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
  effectiveMode,
  breakerOpen,
  health,
  supportedCapabilities,
  dashboardCapabilities,
}) {
  const records = snapshot.records ?? [];
  const blockers = dashboardBlockers(snapshot, health, breakerOpen, effectiveMode);
  const backoffUntil = latestBackoffUntil(records, now);
  const automation = dashboardAutomation({
    status,
    snapshot,
    health: { ...health, now },
    breakerOpen,
    effectiveMode,
    blockers,
    backoffUntil,
  });
  const activities = semanticActivity(records);
  const boundedActivity = bounded(activities, UI_PROTOCOL_LIMITS.activityEntries);
  const lastCycleRecord = [...records].reverse().map(cycleAuditValue).find(Boolean) ?? null;
  const inFlightCount = Math.max(0, Math.min(1_000, Number.isSafeInteger(health.inFlightCount) ? health.inFlightCount : 0));
  const inFlightStartedAt = inFlightCount > 0 && Number.isSafeInteger(health.inFlightStartedAt)
    ? health.inFlightStartedAt
    : inFlightCount > 0 ? now : null;
  const nextEligibleAt = Math.max(
    0,
    backoffUntil,
    snapshot.usage.passive.remaining === 0 ? snapshot.usage.passive.resetAt ?? 0 : 0,
    snapshot.usage.synthesis.remaining === 0 ? snapshot.usage.synthesis.resetAt ?? 0 : 0,
    Number.isSafeInteger(health.nextEligibleAt) ? health.nextEligibleAt : 0,
  ) || null;
  const body = {
    dashboardVersion: UI_DASHBOARD_VERSION,
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
    lastCycle: lastCycleRecord,
    nextEligibleAt,
    usage: snapshot.usage,
    rollout: rolloutSummary(records, health),
    settings: {
      globalMode: snapshot.settings.global.mode,
      repositoryMode: snapshot.settings.repo.mode,
      effectiveMode,
      paused: snapshot.settings.global.paused,
      killSwitchActive: snapshot.settings.global.killSwitchActive || health.runtimeKillSwitch === true,
      repositoryExcluded: snapshot.settings.repo.excluded,
      consent: snapshot.settings.global.consent,
      approvedSkillFolderCount: snapshot.settings.global.allowedSkillRoots.length,
    },
    retention: {
      observationsDays: snapshot.settings.global.retentionDays,
      operationalDays: 90,
    },
    supportedControls: Object.entries(UI_ACTION_CAPABILITIES)
      .filter(([, capability]) => (
        supportedCapabilities.includes(capability) || dashboardCapabilities.includes(capability)
      ))
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
  const proposals = [...latestProposals.values()]
    .map((entry) => entry.payload)
    .filter((proposal) => proposal.projectFingerprint === snapshot.projectFingerprint
      && REVIEWABLE_STATES.has(proposal.state)
      && !PRIVATE_ID_RE.test(proposal.id)
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
  const breakerOpen = (byKind.get("circuit-breaker") ?? []).at(-1)?.payload?.open === true;
  const effectiveMode = resolveMode(snapshot.settings.global.mode, snapshot.settings.repo.mode, {
    killSwitchActive: snapshot.settings.global.killSwitchActive || health.runtimeKillSwitch === true,
    paused: snapshot.settings.global.paused,
    circuitBreakerOpen: breakerOpen,
    processExcluded: health.processExcluded === true,
    repoOptOut: snapshot.settings.repo.excluded,
    hostSupported: health.hostSupported !== false,
    corrupt: health.corrupt === true,
  });
  const status = statusFrom(snapshot.settings, health, breakerOpen, effectiveMode);
  const issuedAt = now;
  const expiresAt = now + UI_PROTOCOL_LIMITS.projectionTtlMs;
  const operationGrants = uiOperationGrants(auditRecords, {
    projectFingerprint: snapshot.projectFingerprint,
    stateRootIdentity,
    generation,
    now,
    capabilities: supportedCapabilities,
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
      effectiveMode,
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
        effectiveMode,
        rationale,
        risk,
        criticScoreBasisPoints: Math.max(0, Math.min(10_000, Math.round(proposal.criticScore * 10_000))),
        criticPassed: proposal.criticPassed,
        validDeterministic: proposal.validDeterministic,
        injectionFlagged: proposal.injectionFlagged,
        tokenImpact: {
          estimatedTokens: content.ok ? Math.ceil(Buffer.byteLength(content.content, "utf8") / 4) : 0,
          budgetTokens: mergedBudgets(snapshot.settings).tokensPerSynthesis,
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
  const dashboard = buildDashboard(snapshot, {
    index,
    stateRootIdentity,
    now,
    status,
    effectiveMode,
    breakerOpen,
    health,
    supportedCapabilities,
    dashboardCapabilities: supportedDashboardCapabilities,
  });
  const requested = [...new Set(detailProposalIds)].slice(0, UI_PROTOCOL_LIMITS.residentDetails);
  const detailById = new Map(detailCandidates.map((candidate) => [candidate.proposal.id, candidate.detail]));
  const publicationDetails = boundedReviews.included.map((review) => detailById.get(review.proposalId));
  const details = requested.map((proposalId) => detailById.get(proposalId)).filter(Boolean);
  let footprint;
  const unavailableDetailIds = requested.filter((proposalId) => !detailById.has(proposalId));
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
