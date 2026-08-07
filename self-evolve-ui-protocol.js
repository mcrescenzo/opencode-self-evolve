import { createHash } from "node:crypto";
import { deepFreeze } from "./self-evolve-schemas.js";

export const UI_PROJECTION_VERSION = 1;
export const UI_DASHBOARD_VERSION = 2;
export const UI_DASHBOARD_VERSIONS = Object.freeze([1, UI_DASHBOARD_VERSION]);
export const UI_OPERATION_PROTOCOL_VERSION = 1;
export const UI_CAPABILITIES = Object.freeze([
  "legacy-control-v1",
  "legacy-decision-v1",
  "operation-export-v1",
  "operation-kill-switch-v1",
  "operation-pause-v1",
  "operation-purge-all-v1",
  "operation-purge-scope-v1",
  "operation-retry-bootstrap-v1",
  "operation-rollback-v1",
  "operation-snooze-v1",
  "projection-index-v1",
  "projection-review-detail-v1",
]);
export const UI_DASHBOARD_CAPABILITIES = Object.freeze([
  "control-repo-mode-v1",
  "decision-feedback-v1",
]);
export const UI_PROTOCOL_COMPATIBILITY = Object.freeze({
  newTuiOldServer: "legacy-read-only-no-new-writes",
  oldTuiNewServer: "legacy-protocols-retained-no-new-writes",
});
export const UI_PROTOCOL_LIMITS = Object.freeze({
  canonicalDepth: 64,
  canonicalBytes: 1024 * 1024,
  overflowSourceItems: 4_096,
  capabilities: 32,
  reviewIndexEntries: 64,
  operationEntries: 32,
  allowedActions: 16,
  diffLines: 2_048,
  diffBytes: 64 * 1024,
  evidenceEntries: 32,
  auditEntries: 64,
  activityEntries: 64,
  eligibilityReasons: 32,
  reasonBytes: 512,
  dashboardSummaryBytes: 512,
  summaryBytes: 2 * 1024,
  rationaleBytes: 2 * 1024,
  indexBytes: 64 * 1024,
  dashboardBytes: 64 * 1024,
  detailBytes: 128 * 1024,
  operationBytes: 8 * 1024,
  responseBytes: 4 * 1024,
  totalProjectionBytes: 256 * 1024,
  residentDetails: 2,
  projectionTtlMs: 5 * 60 * 1000,
  operationTtlMs: 60 * 1000,
  snoozeMaxMs: 365 * 24 * 60 * 60 * 1000,
  futureSkewMs: 30 * 1000,
});

export const UI_ACTIONS = Object.freeze([
  "acknowledge-audit",
  "apply-proposal",
  "export-data",
  "purge-all",
  "purge-scope",
  "reject-proposal",
  "retry-bootstrap",
  "rollback-proposal",
  "set-kill-switch",
  "set-paused",
  "set-repo-mode",
  "snooze-proposal",
]);
export const UI_OPERATION_ACTIONS = Object.freeze([
  "export-data",
  "purge-all",
  "purge-scope",
  "retry-bootstrap",
  "rollback-proposal",
  "set-kill-switch",
  "set-paused",
  "snooze-proposal",
]);
export const UI_PROJECTION_INDEX_FIELDS = Object.freeze([
  "projectionVersion", "projectFingerprint", "stateRootIdentity",
  "generation", "issuedAt", "expiresAt", "capabilities", "status", "budgets", "reviews",
  "operations", "allowedActions", "overflow", "projectionHash",
]);
export const UI_REVIEW_DETAIL_FIELDS = Object.freeze([
  "projectionVersion", "projectFingerprint", "stateRootIdentity",
  "generation", "proposalId", "revision", "issuedAt", "expiresAt", "summary", "diff",
  "evidence", "audit", "allowedActions", "overflow", "detailHash",
]);
export const UI_DASHBOARD_FIELDS = Object.freeze([
  "dashboardVersion", "projectFingerprint", "stateRootIdentity", "generation", "indexHash",
  "generatedAt", "capabilities", "automation", "blockers", "inFlight", "lastCycle", "nextEligibleAt",
  "usage", "rollout", "settings", "retention", "supportedControls", "activity",
  "overflow", "dashboardHash",
]);
export const UI_OPERATION_REQUEST_FIELDS = Object.freeze([
  "operationProtocolVersion", "requestId", "projectFingerprint", "stateRootIdentity",
  "generation", "projectionHash", "action", "capability", "actor", "issuedAt", "expiresAt",
  "nonce", "payload", "operationHash",
]);
export const UI_OPERATION_RESPONSE_FIELDS = Object.freeze([
  "operationProtocolVersion", "requestId", "projectFingerprint", "stateRootIdentity", "action",
  "requestHash", "ok", "status", "processedAt", "reason", "responseHash",
]);

const UI_PROTOCOL_OFFER_FIELDS = Object.freeze(["projectionVersions", "operationProtocolVersions", "capabilities"]);
const INDEX_STATUS_FIELDS = Object.freeze([
  "state", "reason", "storedMode", "effectiveMode", "paused", "killSwitchActive",
  "repoExcluded", "circuitBreakerOpen",
]);
const BUDGET_FIELDS = Object.freeze([
  "passiveCallsPerHour", "synthesisPerDay", "tokensPerSynthesis",
  "concurrentObservationsPerProject", "concurrentSynthesesGlobal", "idleDebounceMs",
  "storageQuotaMiB",
]);
const REVIEW_INDEX_ENTRY_FIELDS = Object.freeze([
  "proposalId", "state", "target", "attention", "updatedAt", "detailRevision", "detailHash",
]);
const OPERATION_ENTRY_FIELDS = Object.freeze(["requestId", "action", "status", "updatedAt", "reason"]);
const ALLOWED_ACTION_FIELDS = Object.freeze(["action", "capability", "nonce", "expiresAt"]);
const OVERFLOW_FIELDS = Object.freeze(["truncated", "includedCount", "omittedCount", "omittedBytes", "reason"]);
const INDEX_OVERFLOW_FIELDS = Object.freeze(["reviews", "operations", "allowedActions"]);
const DETAIL_SUMMARY_FIELDS = Object.freeze([
  "state", "target", "effectiveMode", "rationale", "risk", "criticScoreBasisPoints",
  "criticPassed", "validDeterministic", "injectionFlagged", "tokenImpact", "eligibility",
  "rollback", "operation",
]);
const DETAIL_TARGET_FIELDS = Object.freeze(["relativePath", "currentHash", "proposedContentHash"]);
const TOKEN_IMPACT_FIELDS = Object.freeze(["estimatedTokens", "budgetTokens"]);
const ELIGIBILITY_FIELDS = Object.freeze(["eligible", "reasons", "checks"]);
const ELIGIBILITY_CHECK_FIELDS = Object.freeze(["name", "met", "actual", "required"]);
const ROLLBACK_FIELDS = Object.freeze(["eligible", "reason", "appliedHash"]);
const DETAIL_OPERATION_FIELDS = Object.freeze(["status", "requestId", "reason", "updatedAt"]);
const DIFF_FIELDS = Object.freeze(["kind", "lines", "overflow"]);
const EVIDENCE_FIELDS = Object.freeze(["id", "kind", "summary", "occurredAt", "redacted"]);
const AUDIT_FIELDS = Object.freeze(["id", "kind", "summary", "timestamp"]);
const DETAIL_OVERFLOW_FIELDS = Object.freeze(["evidence", "audit", "allowedActions"]);
const DASHBOARD_AUTOMATION_FIELDS = Object.freeze(["state", "reason"]);
const DASHBOARD_BLOCKER_FIELDS = Object.freeze(["code", "summary", "destination"]);
const DASHBOARD_IN_FLIGHT_FIELDS = Object.freeze(["active", "count", "stage", "startedAt"]);
const DASHBOARD_LAST_CYCLE_FIELDS = Object.freeze([
  "outcome", "triggerClass", "mode", "observationCount", "eligibilityCount",
  "proposalId", "occurredAt", "reason",
]);
const DASHBOARD_USAGE_FIELDS = Object.freeze(["passive", "synthesis", "storage"]);
const DASHBOARD_BUDGET_USAGE_FIELDS = Object.freeze(["used", "limit", "remaining", "resetAt"]);
const DASHBOARD_STORAGE_USAGE_FIELDS = Object.freeze(["usedBytes", "limitBytes", "remainingBytes"]);
const DASHBOARD_ROLLOUT_FIELDS = Object.freeze([
  "ready", "synthesesObserved", "minSynthesesObserved", "successRateBasisPoints",
  "minSuccessRateBasisPoints",
]);
const DASHBOARD_SETTINGS_FIELDS = Object.freeze([
  "globalMode", "repositoryMode", "effectiveMode", "paused", "killSwitchActive",
  "repositoryExcluded", "consent", "approvedSkillFolderCount",
]);
const DASHBOARD_CONSENT_FIELDS = Object.freeze([
  "passiveCalls", "durableObservations", "sanitizedExcerpts", "crossRepoAggregation",
]);
const DASHBOARD_RETENTION_FIELDS = Object.freeze(["observationsDays", "operationalDays"]);
const DASHBOARD_ACTIVITY_FIELDS = Object.freeze([
  "id", "category", "audience", "outcome", "summary", "occurredAt", "proposalId", "reason",
]);
const DASHBOARD_OVERFLOW_FIELDS = Object.freeze(["activity"]);
const SNOOZE_PAYLOAD_FIELDS = Object.freeze([
  "proposalId", "targetHash", "proposedContentHash", "decisionVersion", "snoozedUntil",
]);
const ROLLBACK_PAYLOAD_FIELDS = Object.freeze(["proposalId", "appliedHash", "decisionVersion"]);
const SETTINGS_PAYLOAD_FIELDS = Object.freeze(["enabled", "settingsVersion"]);
const PAUSE_PAYLOAD_FIELDS = Object.freeze(["paused", "settingsVersion"]);
const PURGE_SCOPE_PAYLOAD_FIELDS = Object.freeze(["scope", "confirmation"]);
const CONFIRMATION_PAYLOAD_FIELDS = Object.freeze(["confirmation"]);
const EXPORT_PAYLOAD_FIELDS = Object.freeze(["scope", "confirmation"]);
const MODES = Object.freeze(["manual", "auto", "yolo"]);
const PROPOSAL_STATES = Object.freeze([
  "critic-pending", "pending", "approved", "rejected", "applied", "rolled-back", "superseded", "failed-closed",
]);
export const UI_DASHBOARD_AUTOMATION_STATES = Object.freeze([
  "terminal", "corrupt", "emergency-stop", "circuit-breaker", "paused", "excluded",
  "on-demand", "setup-required", "running", "backoff", "budget", "quiet-period", "ready",
]);
export const UI_DASHBOARD_BLOCKER_DESTINATIONS = deepFreeze({
  "unsupported-host": { dashboard: "settings", section: "settings", anchor: "unsupported-host" },
  "state-root": { dashboard: "settings", section: "settings", anchor: "state-root" },
  "provider": { dashboard: "settings", section: "settings", anchor: "provider" },
  "first-run": { dashboard: "home", section: "home" },
  "restart-required": { dashboard: "settings", section: "settings", anchor: "restart-required" },
  "passive-consent": { dashboard: "settings", section: "settings", anchor: "passive-consent" },
  "observation-consent": { dashboard: "settings", section: "settings", anchor: "observation-consent" },
  "approved-skill-folders": { dashboard: "settings", section: "settings", anchor: "approved-skill-folders" },
  "yolo-rollout": { dashboard: "settings", section: "settings", anchor: "yolo-rollout" },
  "corrupt-state": { dashboard: "activity-errors", section: "activity", filter: "errors" },
  "emergency-stop": { dashboard: "settings", section: "settings", anchor: "emergency-stop" },
  "circuit-breaker": { dashboard: "activity-errors", section: "activity", filter: "errors" },
  "paused": { dashboard: "home", section: "home" },
  "repository-excluded": { dashboard: "settings", section: "settings", anchor: "project-scope" },
});
export const UI_DASHBOARD_BLOCKER_CODES = Object.freeze(Object.keys(UI_DASHBOARD_BLOCKER_DESTINATIONS));
export const UI_CONTROL_CENTER_SETTINGS_ANCHORS = Object.freeze([
  "setup", "modes", "privacy", "limits", "maintenance",
  ...new Set(Object.values(UI_DASHBOARD_BLOCKER_DESTINATIONS)
    .filter((entry) => entry.section === "settings")
    .map((entry) => entry.anchor)),
]);
export const UI_DASHBOARD_OUTCOMES = Object.freeze([
  "cursor-unchanged", "no-observations", "not-eligible", "valid-no-change",
  "recommendation-created", "applied", "deferred", "failed-closed", "failed",
  "rolled-back", "recommendation-approved", "recommendation-rejected",
  "recommendation-snoozed", "recommendation-acknowledged", "breaker-open",
  "breaker-recovered", "paused", "resumed", "emergency-stop-enabled",
  "emergency-stop-disabled", "project-excluded", "project-included",
  "export-completed", "purge-completed", "purge-all-accepted", "bootstrap-completed",
  "recovery-completed",
]);
export const UI_DASHBOARD_REASON_CODES = Object.freeze([
  "already-processed", "empty-window", "cursor-gap", "insufficient-evidence",
  "passive-provider-budget-exhausted", "passive-provider-budget-insufficient",
  "synthesis-budget-exhausted", "quiet-period", "backoff", "lease-busy",
  "no-change", "critic-rejected", "validation-failed", "apply-deferred",
  "apply-failed", "pipeline-failed", "operation-failed", "three-failures-in-24h",
  "startup-pending", "setup-required", "restart-required", "unsupported-host", "corrupt-state",
  "emergency-stop", "paused", "repository-excluded", "unknown",
]);
export const UI_ACTION_CAPABILITIES = Object.freeze({
  "acknowledge-audit": "projection-review-detail-v1",
  "apply-proposal": "legacy-decision-v1",
  "export-data": "operation-export-v1",
  "purge-all": "operation-purge-all-v1",
  "purge-scope": "operation-purge-scope-v1",
  "reject-proposal": "legacy-decision-v1",
  "retry-bootstrap": "operation-retry-bootstrap-v1",
  "rollback-proposal": "operation-rollback-v1",
  "set-kill-switch": "operation-kill-switch-v1",
  "set-paused": "operation-pause-v1",
  "set-repo-mode": "control-repo-mode-v1",
  "snooze-proposal": "operation-snooze-v1",
});
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const RECEIPT_TYPES = Object.freeze([
  "repeated-command", "repeated-tool-error", "repeated-manual-procedure", "repeated-clarification", "eligibility",
]);
const AUDIT_KINDS = Object.freeze([
  "apply", "rollback", "decision", "mode-change", "kill-switch", "purge", "lease", "corruption",
]);

const HASH_DOMAINS = Object.freeze({
  "projection-index": "self-evolve-ui-projection-index-v1",
  dashboard: "self-evolve-ui-dashboard-v1",
  "dashboard-v2": "self-evolve-ui-dashboard-v2",
  "review-detail": "self-evolve-ui-review-detail-v1",
  "operation-request": "self-evolve-ui-operation-request-v1",
  "operation-response": "self-evolve-ui-operation-response-v1",
});

function fail(code, detail = "") {
  throw new TypeError(detail ? `${code}: ${detail}` : code);
}

function exactKeys(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}-malformed`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label}-malformed`);
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}-unknown-field`, key);
  for (const field of fields) if (!Object.hasOwn(value, field)) fail(`${label}-missing-field`, field);
}

function asEnum(value, allowed, label) {
  if (!allowed.includes(value)) fail(`invalid-${label}`, String(value));
  return value;
}

function asBoolean(value, label) {
  if (typeof value !== "boolean") fail(`invalid-${label}`);
  return value;
}

function asInt(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}-out-of-bounds`);
  return value;
}

function asTimestamp(value, label) {
  return asInt(value, label, { max: 8_640_000_000_000_000 });
}

function asHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail(`invalid-${label}`);
  return value;
}

function asId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(`invalid-${label}`);
  return value;
}

function asText(value, label, maxBytes, { nullable = false, singleLine = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") fail(`invalid-${label}`);
  assertUnicode(value);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)) fail(`invalid-${label}-control-character`);
  if (singleLine && /[\r\n]/u.test(value)) fail(`invalid-${label}-line-break`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail(`${label}-out-of-bounds`);
  return value;
}

function asNullableReason(value) {
  return asText(value, "reason", UI_PROTOCOL_LIMITS.reasonBytes, { nullable: true });
}

function assertVersion(value, expected, label) {
  if (value !== expected) fail(`unsupported-${label}-version`, String(value));
  return value;
}

function assertEnvelopeVersion(value, field, expected, label, envelopeLabel) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${envelopeLabel}-malformed`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${envelopeLabel}-malformed`);
  if (!Object.hasOwn(value, field)) fail(`${envelopeLabel}-missing-field`, field);
  return assertVersion(value[field], expected, label);
}

function asRelativeTarget(value) {
  const target = asText(value, "target", 1024, { singleLine: true });
  if (!target || target.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(target) || target.includes("\\")) fail("invalid-target");
  const components = target.split("/");
  if (components.some((component) => !component || component === "." || component === "..")) fail("invalid-target");
  return target;
}

function assertOrdered(values, compare, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1], values[index]) > 0) fail(`${label}-not-sorted`);
  }
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function exactSortedList(value, label, allowed, max, unknownCode) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}-out-of-bounds`);
  const clean = value.map((item) => {
    if (!allowed.includes(item)) fail(unknownCode, String(item));
    return item;
  });
  if (new Set(clean).size !== clean.length) fail(`${label}-duplicate`);
  const sorted = [...clean].sort();
  if (clean.some((item, index) => item !== sorted[index])) fail(`${label}-not-sorted`);
  return Object.freeze(clean);
}

function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("invalid-unicode");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("invalid-unicode");
    }
  }
}

function canonical(value, depth = 0) {
  if (depth > UI_PROTOCOL_LIMITS.canonicalDepth) fail("canonical-depth-out-of-bounds");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicode(value);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)) fail("canonical-control-character");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("canonical-number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) fail("sparse-array");
    }
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("canonical-object");
    return `{${Object.keys(value).sort().map((key) => {
      assertUnicode(key);
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(key)) fail("canonical-control-character");
      return `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`;
    }).join(",")}}`;
  }
  fail("canonical-value");
}

export function canonicalUiJson(value) {
  const source = canonical(value);
  if (Buffer.byteLength(source, "utf8") > UI_PROTOCOL_LIMITS.canonicalBytes) fail("canonical-footprint-exceeded");
  return source;
}

export function hashUiProtocol(kind, value) {
  const domain = kind === "dashboard" && value?.dashboardVersion === 2
    ? HASH_DOMAINS["dashboard-v2"]
    : HASH_DOMAINS[kind];
  if (!domain) fail("unknown-ui-protocol-kind", String(kind));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("canonical-object");
  const omittedField = kind === "projection-index"
    ? "projectionHash"
    : kind === "dashboard"
      ? "dashboardHash"
    : kind === "review-detail"
      ? "detailHash"
      : kind === "operation-request"
        ? "operationHash"
        : "responseHash";
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== omittedField));
  return createHash("sha256").update(`${domain}\n${canonicalUiJson(body)}`).digest("hex");
}

export function makeUiProtocolOffer(value) {
  exactKeys(value, UI_PROTOCOL_OFFER_FIELDS, "ui-protocol-offer");
  const projectionVersions = exactSortedList(value.projectionVersions, "projection-versions", [UI_PROJECTION_VERSION], 4, "unsupported-projection-version");
  const operationProtocolVersions = exactSortedList(value.operationProtocolVersions, "operation-versions", [UI_OPERATION_PROTOCOL_VERSION], 4, "unsupported-operation-version");
  const capabilities = exactSortedList(value.capabilities, "capabilities", UI_CAPABILITIES, 32, "unknown-capability");
  return deepFreeze({ projectionVersions, operationProtocolVersions, capabilities });
}

function legacyNegotiation(reason) {
  return deepFreeze({
    mode: "legacy",
    projectionVersion: null,
    operationProtocolVersion: null,
    capabilities: [],
    reason,
  });
}

function makePeerVersionList(value, label) {
  if (!Array.isArray(value) || value.length > 4) fail(`${label}-out-of-bounds`);
  const clean = value.map((version) => asInt(version, label, { min: 1, max: 1_000_000 }));
  if (new Set(clean).size !== clean.length) fail(`${label}-duplicate`);
  for (let index = 1; index < clean.length; index += 1) {
    if (clean[index - 1] >= clean[index]) fail(`${label}-not-sorted`);
  }
  return clean;
}

function makePeerOffer(value) {
  exactKeys(value, UI_PROTOCOL_OFFER_FIELDS, "ui-protocol-peer-offer");
  if (!Array.isArray(value.capabilities) || value.capabilities.length > UI_PROTOCOL_LIMITS.capabilities) fail("capabilities-out-of-bounds");
  const capabilities = value.capabilities.map((capability) => {
    if (typeof capability !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(capability)) fail("invalid-peer-capability");
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) fail("capabilities-duplicate");
  for (let index = 1; index < capabilities.length; index += 1) {
    if (capabilities[index - 1] >= capabilities[index]) fail("capabilities-not-sorted");
  }
  return {
    projectionVersions: makePeerVersionList(value.projectionVersions, "projection-versions"),
    operationProtocolVersions: makePeerVersionList(value.operationProtocolVersions, "operation-versions"),
    capabilities,
  };
}

export function negotiateUiProtocol(serverValue, clientValue) {
  if (serverValue === null || serverValue === undefined) return legacyNegotiation("server-offer-unavailable");
  if (clientValue === null || clientValue === undefined) return legacyNegotiation("client-offer-unavailable");
  const server = makePeerOffer(serverValue);
  const client = makePeerOffer(clientValue);
  const projectionVersion = [...server.projectionVersions].reverse().find((version) => client.projectionVersions.includes(version)) ?? null;
  if (projectionVersion === null) return legacyNegotiation("projection-version-unavailable");
  const operationProtocolVersion = [...server.operationProtocolVersions].reverse().find((version) => client.operationProtocolVersions.includes(version)) ?? null;
  let capabilities = UI_CAPABILITIES.filter((capability) => server.capabilities.includes(capability) && client.capabilities.includes(capability));
  if (operationProtocolVersion === null) capabilities = capabilities.filter((capability) => !capability.startsWith("operation-"));
  return deepFreeze({
    mode: operationProtocolVersion === null ? "read-only" : "native",
    projectionVersion,
    operationProtocolVersion,
    capabilities,
    reason: operationProtocolVersion === null ? "operation-version-unavailable" : null,
  });
}

function makeOverflow(value, includedCount, label) {
  exactKeys(value, OVERFLOW_FIELDS, `${label}-overflow`);
  const marker = {
    truncated: asBoolean(value.truncated, `${label}-overflow-truncated`),
    includedCount: asInt(value.includedCount, `${label}-overflow-included-count`, { max: 1_000_000 }),
    omittedCount: asInt(value.omittedCount, `${label}-overflow-omitted-count`, { max: 1_000_000 }),
    omittedBytes: asInt(value.omittedBytes, `${label}-overflow-omitted-bytes`),
    reason: asEnum(value.reason, ["none", "item-limit", "byte-limit", "footprint-limit"], `${label}-overflow-reason`),
  };
  if (marker.includedCount !== includedCount) fail(`${label}-overflow-included-count-mismatch`);
  if (!marker.truncated && (marker.omittedCount !== 0 || marker.omittedBytes !== 0 || marker.reason !== "none")) {
    fail(`${label}-overflow-inconsistent`);
  }
  if (marker.truncated && (marker.reason === "none" || marker.omittedCount === 0 || marker.omittedBytes === 0)) {
    fail(`${label}-overflow-inconsistent`);
  }
  if (marker.reason === "item-limit" && marker.omittedCount === 0) fail(`${label}-overflow-inconsistent`);
  if (["byte-limit", "footprint-limit"].includes(marker.reason) && marker.omittedBytes === 0) fail(`${label}-overflow-inconsistent`);
  return marker;
}

export function makeUiOverflowMarker(includedCountValue, omittedValues = [], reason = "none") {
  const includedCount = asInt(includedCountValue, "overflow-included-count", { max: 1_000_000 });
  asEnum(reason, ["none", "item-limit", "byte-limit", "footprint-limit"], "overflow-reason");
  if (!Array.isArray(omittedValues) || omittedValues.length > UI_PROTOCOL_LIMITS.overflowSourceItems) fail("overflow-omitted-items-out-of-bounds");
  const omittedBytes = omittedValues.reduce((total, item) => {
    const next = total + Buffer.byteLength(canonicalUiJson(item), "utf8");
    if (!Number.isSafeInteger(next) || next > UI_PROTOCOL_LIMITS.canonicalBytes) fail("overflow-omitted-bytes-out-of-bounds");
    return next;
  }, 0);
  const truncated = omittedValues.length > 0;
  if (truncated && reason === "none") fail("invalid-overflow-reason");
  const marker = {
    truncated,
    includedCount,
    omittedCount: omittedValues.length,
    omittedBytes,
    reason: truncated ? reason : "none",
  };
  return deepFreeze(makeOverflow(marker, includedCount, "generated"));
}

function makeProjectionContext(value) {
  exactKeys(value, ["projectFingerprint", "stateRootIdentity", "generation", "now", "supportedCapabilities"], "projection-context");
  return {
    projectFingerprint: asHash(value.projectFingerprint, "project-fingerprint"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "generation"),
    now: asTimestamp(value.now, "now"),
    supportedCapabilities: exactSortedList(value.supportedCapabilities, "capabilities", UI_CAPABILITIES, UI_PROTOCOL_LIMITS.capabilities, "unknown-capability"),
  };
}

function makeStatus(value) {
  exactKeys(value, INDEX_STATUS_FIELDS, "ui-projection-status");
  return {
    state: asEnum(value.state, ["ready", "setup-required", "startup-pending", "unavailable", "corrupt", "terminal"], "projection-status"),
    reason: asNullableReason(value.reason),
    storedMode: asEnum(value.storedMode, MODES, "stored-mode"),
    effectiveMode: asEnum(value.effectiveMode, MODES, "effective-mode"),
    paused: asBoolean(value.paused, "paused"),
    killSwitchActive: asBoolean(value.killSwitchActive, "kill-switch"),
    repoExcluded: asBoolean(value.repoExcluded, "repo-excluded"),
    circuitBreakerOpen: asBoolean(value.circuitBreakerOpen, "circuit-breaker"),
  };
}

function makeBudgets(value) {
  exactKeys(value, BUDGET_FIELDS, "ui-projection-budgets");
  return Object.fromEntries(BUDGET_FIELDS.map((field) => [field, asInt(value[field], `budget-${field}`, { max: 1_000_000_000 })]));
}

function asNullableTimestamp(value, label) {
  return value === null ? null : asTimestamp(value, label);
}

function makeDashboardReason(value, label = "dashboard-reason") {
  return value === null ? null : asEnum(value, UI_DASHBOARD_REASON_CODES, label);
}

function makeDashboardBudgetUsage(value, label) {
  exactKeys(value, DASHBOARD_BUDGET_USAGE_FIELDS, `${label}-usage`);
  const used = asInt(value.used, `${label}-used`, { max: 1_000_000_000 });
  const limit = asInt(value.limit, `${label}-limit`, { max: 1_000_000_000 });
  const remaining = asInt(value.remaining, `${label}-remaining`, { max: 1_000_000_000 });
  if (remaining !== Math.max(0, limit - used)) fail(`${label}-remaining-mismatch`);
  return { used, limit, remaining, resetAt: asNullableTimestamp(value.resetAt, `${label}-reset-at`) };
}

function makeDashboardUsage(value) {
  exactKeys(value, DASHBOARD_USAGE_FIELDS, "dashboard-usage");
  exactKeys(value.storage, DASHBOARD_STORAGE_USAGE_FIELDS, "dashboard-storage-usage");
  const usedBytes = asInt(value.storage.usedBytes, "storage-used-bytes");
  const limitBytes = asInt(value.storage.limitBytes, "storage-limit-bytes");
  const remainingBytes = asInt(value.storage.remainingBytes, "storage-remaining-bytes");
  if (remainingBytes !== Math.max(0, limitBytes - usedBytes)) fail("storage-remaining-mismatch");
  return {
    passive: makeDashboardBudgetUsage(value.passive, "passive"),
    synthesis: makeDashboardBudgetUsage(value.synthesis, "synthesis"),
    storage: { usedBytes, limitBytes, remainingBytes },
  };
}

function makeDashboardLastCycle(value) {
  if (value === null) return null;
  exactKeys(value, DASHBOARD_LAST_CYCLE_FIELDS, "dashboard-last-cycle");
  return {
    outcome: asEnum(value.outcome, UI_DASHBOARD_OUTCOMES.slice(0, 9), "cycle-outcome"),
    triggerClass: asEnum(value.triggerClass, ["manual", "idle", "recovery", "other"], "cycle-trigger-class"),
    mode: asEnum(value.mode, MODES, "cycle-mode"),
    observationCount: asInt(value.observationCount, "cycle-observation-count", { max: 1_000_000 }),
    eligibilityCount: asInt(value.eligibilityCount, "cycle-eligibility-count", { max: 1_000_000 }),
    proposalId: value.proposalId === null ? null : asId(value.proposalId, "cycle-proposal-id"),
    occurredAt: asTimestamp(value.occurredAt, "cycle-occurred-at"),
    reason: makeDashboardReason(value.reason, "cycle-reason"),
  };
}

function makeDashboardActivity(value) {
  exactKeys(value, DASHBOARD_ACTIVITY_FIELDS, "dashboard-activity-entry");
  return {
    id: asHash(value.id, "activity-id"),
    category: asEnum(value.category, ["cycle", "recommendation", "system", "error"], "activity-category"),
    audience: asEnum(value.audience, ["default", "diagnostic"], "activity-audience"),
    outcome: asEnum(value.outcome, UI_DASHBOARD_OUTCOMES, "activity-outcome"),
    summary: asText(value.summary, "activity-summary", UI_PROTOCOL_LIMITS.dashboardSummaryBytes),
    occurredAt: asTimestamp(value.occurredAt, "activity-occurred-at"),
    proposalId: value.proposalId === null ? null : asId(value.proposalId, "activity-proposal-id"),
    reason: makeDashboardReason(value.reason, "activity-reason"),
  };
}

function makeDashboardContext(value) {
  exactKeys(value, [
    "projectFingerprint", "stateRootIdentity", "generation", "indexHash", "now",
  ], "dashboard-context");
  return {
    projectFingerprint: asHash(value.projectFingerprint, "project-fingerprint"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "generation"),
    indexHash: asHash(value.indexHash, "index-hash"),
    now: asTimestamp(value.now, "now"),
  };
}

export function makeUiDashboard(value, expectedValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ui-dashboard-malformed");
  if (!Object.hasOwn(value, "dashboardVersion")) fail("ui-dashboard-missing-field", "dashboardVersion");
  if (!UI_DASHBOARD_VERSIONS.includes(value.dashboardVersion)) {
    fail("unsupported-dashboard-version", String(value.dashboardVersion));
  }
  exactKeys(value, UI_DASHBOARD_FIELDS, "ui-dashboard");
  const dashboardVersion = value.dashboardVersion;
  const expected = makeDashboardContext(expectedValue);
  const projectFingerprint = asHash(value.projectFingerprint, "project-fingerprint");
  const stateRootIdentity = asHash(value.stateRootIdentity, "state-root-identity");
  const generation = asHash(value.generation, "generation");
  const indexHash = asHash(value.indexHash, "index-hash");
  if (projectFingerprint !== expected.projectFingerprint) fail("cross-project");
  if (stateRootIdentity !== expected.stateRootIdentity) fail("cross-root");
  if (generation !== expected.generation) fail("stale-generation");
  if (indexHash !== expected.indexHash) fail("stale-projection");
  const generatedAt = asTimestamp(value.generatedAt, "dashboard-generated-at");
  if (generatedAt > expected.now + UI_PROTOCOL_LIMITS.futureSkewMs) fail("future-dashboard");
  if (generatedAt + UI_PROTOCOL_LIMITS.projectionTtlMs <= expected.now) fail("expired-dashboard");
  const capabilities = exactSortedList(
    value.capabilities,
    "dashboard-capabilities",
    UI_DASHBOARD_CAPABILITIES,
    UI_DASHBOARD_CAPABILITIES.length,
    "unknown-dashboard-capability",
  );
  exactKeys(value.automation, DASHBOARD_AUTOMATION_FIELDS, "dashboard-automation");
  const automation = {
    state: asEnum(value.automation.state, UI_DASHBOARD_AUTOMATION_STATES, "dashboard-automation-state"),
    reason: makeDashboardReason(value.automation.reason, "dashboard-automation-reason"),
  };
  if (!Array.isArray(value.blockers) || value.blockers.length > UI_DASHBOARD_BLOCKER_CODES.length) fail("dashboard-blockers-out-of-bounds");
  const blockers = value.blockers.map((blocker) => {
    exactKeys(blocker, DASHBOARD_BLOCKER_FIELDS, "dashboard-blocker");
    const output = {
      code: asEnum(blocker.code, UI_DASHBOARD_BLOCKER_CODES, "dashboard-blocker-code"),
      summary: asText(blocker.summary, "dashboard-blocker-summary", UI_PROTOCOL_LIMITS.dashboardSummaryBytes),
      destination: asEnum(blocker.destination, ["home", "recommendations", "activity-errors", "settings"], "dashboard-destination"),
    };
    if (UI_DASHBOARD_BLOCKER_DESTINATIONS[output.code].dashboard !== output.destination) {
      fail("dashboard-blocker-destination-mismatch");
    }
    return output;
  });
  if (new Set(blockers.map((blocker) => blocker.code)).size !== blockers.length) fail("dashboard-blocker-duplicate");
  exactKeys(value.inFlight, DASHBOARD_IN_FLIGHT_FIELDS, "dashboard-in-flight");
  const inFlight = {
    active: asBoolean(value.inFlight.active, "dashboard-in-flight-active"),
    count: asInt(value.inFlight.count, "dashboard-in-flight-count", { max: 1_000 }),
    stage: value.inFlight.stage === null
      ? null
      : asEnum(value.inFlight.stage, ["pipeline", "apply", "operation"], "dashboard-in-flight-stage"),
    startedAt: asNullableTimestamp(value.inFlight.startedAt, "dashboard-in-flight-started-at"),
  };
  if (inFlight.active !== (inFlight.count > 0)
      || (inFlight.active && (inFlight.stage === null || inFlight.startedAt === null))
      || (!inFlight.active && (inFlight.stage !== null || inFlight.startedAt !== null))) {
    fail("dashboard-in-flight-inconsistent");
  }
  const lastCycle = makeDashboardLastCycle(value.lastCycle);
  const nextEligibleAt = asNullableTimestamp(value.nextEligibleAt, "dashboard-next-eligible-at");
  exactKeys(value.rollout, DASHBOARD_ROLLOUT_FIELDS, "dashboard-rollout");
  const rollout = {
    ready: asBoolean(value.rollout.ready, "dashboard-rollout-ready"),
    synthesesObserved: asInt(value.rollout.synthesesObserved, "dashboard-syntheses-observed", { max: 1_000_000_000 }),
    minSynthesesObserved: asInt(value.rollout.minSynthesesObserved, "dashboard-min-syntheses-observed", { max: 1_000_000_000 }),
    successRateBasisPoints: asInt(value.rollout.successRateBasisPoints, "dashboard-success-rate", { max: 10_000 }),
    minSuccessRateBasisPoints: asInt(value.rollout.minSuccessRateBasisPoints, "dashboard-min-success-rate", { max: 10_000 }),
  };
  if (rollout.ready !== (rollout.synthesesObserved >= rollout.minSynthesesObserved
      && rollout.successRateBasisPoints >= rollout.minSuccessRateBasisPoints)) {
    fail("dashboard-rollout-readiness-mismatch");
  }
  exactKeys(value.settings, DASHBOARD_SETTINGS_FIELDS, "dashboard-settings");
  exactKeys(value.settings.consent, DASHBOARD_CONSENT_FIELDS, "dashboard-consent");
  const settings = {
    globalMode: asEnum(value.settings.globalMode, MODES, "dashboard-global-mode"),
    repositoryMode: asEnum(value.settings.repositoryMode, ["inherit", ...MODES], "dashboard-repository-mode"),
    effectiveMode: asEnum(value.settings.effectiveMode, MODES, "dashboard-effective-mode"),
    paused: asBoolean(value.settings.paused, "dashboard-paused"),
    killSwitchActive: asBoolean(value.settings.killSwitchActive, "dashboard-kill-switch"),
    repositoryExcluded: asBoolean(value.settings.repositoryExcluded, "dashboard-repository-excluded"),
    consent: Object.fromEntries(DASHBOARD_CONSENT_FIELDS.map((field) => [
      field, asBoolean(value.settings.consent[field], `dashboard-consent-${field}`),
    ])),
    approvedSkillFolderCount: asInt(value.settings.approvedSkillFolderCount, "dashboard-approved-skill-folder-count", { max: 1_000_000 }),
  };
  exactKeys(value.retention, DASHBOARD_RETENTION_FIELDS, "dashboard-retention");
  const retention = dashboardVersion === 1
    ? {
        observationsDays: asInt(value.retention.observationsDays, "dashboard-observation-retention", { min: 1, max: 3_650 }),
        operationalDays: asInt(value.retention.operationalDays, "dashboard-operational-retention", { min: 1, max: 3_650 }),
      }
    : {
        observationsDays: asInt(value.retention.observationsDays, "dashboard-observation-retention", { min: 1, max: 3_650 }),
        operationalDays: asInt(value.retention.operationalDays, "dashboard-operational-retention", { min: 3, max: 10_950 }),
      };
  if (dashboardVersion === 2 && retention.operationalDays !== retention.observationsDays * 3) {
    fail("dashboard-retention-mismatch");
  }
  const supportedControls = exactSortedList(
    value.supportedControls,
    "dashboard-supported-controls",
    UI_ACTIONS,
    UI_ACTIONS.length,
    "unknown-dashboard-control",
  );
  for (const action of supportedControls) {
    const capability = UI_ACTION_CAPABILITIES[action];
    if (!UI_CAPABILITIES.includes(capability) && !capabilities.includes(capability)) {
      fail("unsupported-dashboard-control", action);
    }
  }
  if (!Array.isArray(value.activity) || value.activity.length > UI_PROTOCOL_LIMITS.activityEntries) fail("dashboard-activity-out-of-bounds");
  const activity = value.activity.map(makeDashboardActivity);
  assertOrdered(activity, (left, right) => right.occurredAt - left.occurredAt || compareText(left.id, right.id), "dashboard-activity");
  if (new Set(activity.map((entry) => entry.id)).size !== activity.length) fail("dashboard-activity-duplicate");
  exactKeys(value.overflow, DASHBOARD_OVERFLOW_FIELDS, "dashboard-overflow");
  const overflow = { activity: makeOverflow(value.overflow.activity, activity.length, "dashboard-activity") };
  const clean = {
    dashboardVersion,
    projectFingerprint,
    stateRootIdentity,
    generation,
    indexHash,
    generatedAt,
    capabilities,
    automation,
    blockers,
    inFlight,
    lastCycle,
    nextEligibleAt,
    usage: makeDashboardUsage(value.usage),
    rollout,
    settings,
    retention,
    supportedControls,
    activity,
    overflow,
    dashboardHash: asHash(value.dashboardHash, "dashboard-hash"),
  };
  if (hashUiProtocol("dashboard", clean) !== clean.dashboardHash) fail("dashboard-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > UI_PROTOCOL_LIMITS.dashboardBytes) fail("dashboard-footprint-exceeded");
  return deepFreeze(clean);
}

function makeReviewIndexEntry(value) {
  exactKeys(value, REVIEW_INDEX_ENTRY_FIELDS, "ui-review-index-entry");
  return {
    proposalId: asId(value.proposalId, "proposal-id"),
    state: asEnum(value.state, PROPOSAL_STATES, "proposal-state"),
    target: asRelativeTarget(value.target),
    attention: asEnum(value.attention, ["critical", "warning", "normal"], "attention"),
    updatedAt: asTimestamp(value.updatedAt, "review-updated-at"),
    detailRevision: asInt(value.detailRevision, "detail-revision", { max: 1_000_000 }),
    detailHash: asHash(value.detailHash, "detail-hash"),
  };
}

function makeOperationEntry(value) {
  exactKeys(value, OPERATION_ENTRY_FIELDS, "ui-operation-entry");
  return {
    requestId: asId(value.requestId, "request-id"),
    action: asEnum(value.action, UI_ACTIONS, "ui-action"),
    status: asEnum(value.status, ["queued", "running", "completed", "failed", "accepted-terminal"], "operation-status"),
    updatedAt: asTimestamp(value.updatedAt, "operation-updated-at"),
    reason: asNullableReason(value.reason),
  };
}

function makeAllowedAction(value, { capabilities, expiresAt, now }) {
  exactKeys(value, ALLOWED_ACTION_FIELDS, "ui-allowed-action");
  const action = asEnum(value.action, UI_ACTIONS, "ui-action");
  const capability = asEnum(value.capability, UI_CAPABILITIES, "capability");
  if (UI_ACTION_CAPABILITIES[action] !== capability) fail("action-capability-mismatch");
  if (!capabilities.includes(capability)) fail("unsupported-capability", capability);
  if (action === "acknowledge-audit") {
    if (value.nonce !== null || value.expiresAt !== null) fail("local-action-cannot-have-grant");
    return { action, capability, nonce: null, expiresAt: null };
  }
  const actionExpiresAt = asTimestamp(value.expiresAt, "action-expires-at");
  if (actionExpiresAt <= now || actionExpiresAt > expiresAt) fail("invalid-action-expiry");
  return { action, capability, nonce: asId(value.nonce, "action-nonce"), expiresAt: actionExpiresAt };
}

function assertProjectionTimes(issuedAt, expiresAt, now) {
  if (issuedAt > now + UI_PROTOCOL_LIMITS.futureSkewMs) fail("future-projection");
  if (expiresAt <= now) fail("expired-projection");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > UI_PROTOCOL_LIMITS.projectionTtlMs) fail("invalid-projection-lifetime");
}

export function makeUiProjectionIndex(value, expectedValue) {
  assertEnvelopeVersion(value, "projectionVersion", UI_PROJECTION_VERSION, "projection", "ui-projection-index");
  exactKeys(value, UI_PROJECTION_INDEX_FIELDS, "ui-projection-index");
  const expected = makeProjectionContext(expectedValue);
  const projectionVersion = assertVersion(value.projectionVersion, UI_PROJECTION_VERSION, "projection");
  const projectFingerprint = asHash(value.projectFingerprint, "project-fingerprint");
  const stateRootIdentity = asHash(value.stateRootIdentity, "state-root-identity");
  if (projectFingerprint !== expected.projectFingerprint) fail("cross-project");
  if (stateRootIdentity !== expected.stateRootIdentity) fail("cross-root");
  const generation = asHash(value.generation, "generation");
  if (generation !== expected.generation) fail("stale-generation");
  const issuedAt = asTimestamp(value.issuedAt, "projection-issued-at");
  const expiresAt = asTimestamp(value.expiresAt, "projection-expires-at");
  assertProjectionTimes(issuedAt, expiresAt, expected.now);
  const capabilities = exactSortedList(value.capabilities, "capabilities", UI_CAPABILITIES, UI_PROTOCOL_LIMITS.capabilities, "unknown-capability");
  for (const capability of capabilities) {
    if (!expected.supportedCapabilities.includes(capability)) fail("unsupported-capability", capability);
  }
  const reviews = (() => {
    if (!Array.isArray(value.reviews) || value.reviews.length > UI_PROTOCOL_LIMITS.reviewIndexEntries) fail("reviews-out-of-bounds");
    const clean = value.reviews.map(makeReviewIndexEntry);
    const attentionRank = { critical: 0, warning: 1, normal: 2 };
    assertOrdered(clean, (left, right) => attentionRank[left.attention] - attentionRank[right.attention]
      || right.updatedAt - left.updatedAt || compareText(left.proposalId, right.proposalId), "reviews");
    if (new Set(clean.map((entry) => entry.proposalId)).size !== clean.length) fail("duplicate-review");
    return clean;
  })();
  const operations = (() => {
    if (!Array.isArray(value.operations) || value.operations.length > UI_PROTOCOL_LIMITS.operationEntries) fail("operations-out-of-bounds");
    const clean = value.operations.map(makeOperationEntry);
    assertOrdered(clean, (left, right) => right.updatedAt - left.updatedAt || compareText(left.requestId, right.requestId), "operations");
    if (new Set(clean.map((entry) => entry.requestId)).size !== clean.length) fail("duplicate-operation");
    return clean;
  })();
  const allowedActions = (() => {
    if (!Array.isArray(value.allowedActions) || value.allowedActions.length > UI_PROTOCOL_LIMITS.allowedActions) fail("allowed-actions-out-of-bounds");
    const clean = value.allowedActions.map((action) => makeAllowedAction(action, { capabilities, expiresAt, now: expected.now }));
    assertOrdered(clean, (left, right) => compareText(left.action, right.action), "allowed-actions");
    if (new Set(clean.map((entry) => entry.action)).size !== clean.length) fail("duplicate-allowed-action");
    return clean;
  })();
  exactKeys(value.overflow, INDEX_OVERFLOW_FIELDS, "ui-projection-overflow");
  const overflow = {
    reviews: makeOverflow(value.overflow.reviews, reviews.length, "reviews"),
    operations: makeOverflow(value.overflow.operations, operations.length, "operations"),
    allowedActions: makeOverflow(value.overflow.allowedActions, allowedActions.length, "allowed-actions"),
  };
  const clean = {
    projectionVersion,
    projectFingerprint,
    stateRootIdentity,
    generation,
    issuedAt,
    expiresAt,
    capabilities,
    status: makeStatus(value.status),
    budgets: makeBudgets(value.budgets),
    reviews,
    operations,
    allowedActions,
    overflow,
    projectionHash: asHash(value.projectionHash, "projection-hash"),
  };
  if (hashUiProtocol("projection-index", clean) !== clean.projectionHash) fail("projection-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > UI_PROTOCOL_LIMITS.indexBytes) fail("projection-index-footprint-exceeded");
  return deepFreeze(clean);
}

function makeDetailContext(value) {
  exactKeys(value, [
    "projectFingerprint", "stateRootIdentity", "generation", "detailRevision", "detailHash",
    "now", "supportedCapabilities",
  ], "review-detail-context");
  return {
    projectFingerprint: asHash(value.projectFingerprint, "project-fingerprint"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "generation"),
    detailRevision: asInt(value.detailRevision, "detail-revision", { max: 1_000_000 }),
    detailHash: asHash(value.detailHash, "detail-hash"),
    now: asTimestamp(value.now, "now"),
    supportedCapabilities: exactSortedList(value.supportedCapabilities, "capabilities", UI_CAPABILITIES, UI_PROTOCOL_LIMITS.capabilities, "unknown-capability"),
  };
}

function makeEligibility(value) {
  exactKeys(value, ELIGIBILITY_FIELDS, "ui-eligibility");
  if (!Array.isArray(value.reasons) || value.reasons.length > UI_PROTOCOL_LIMITS.eligibilityReasons) fail("eligibility-reasons-out-of-bounds");
  const reasons = value.reasons.map((reason) => asText(reason, "eligibility-reason", UI_PROTOCOL_LIMITS.reasonBytes, { singleLine: true }));
  assertOrdered(reasons, compareText, "eligibility-reasons");
  if (new Set(reasons).size !== reasons.length) fail("duplicate-eligibility-reason");
  if (!Array.isArray(value.checks) || value.checks.length > UI_PROTOCOL_LIMITS.eligibilityReasons) fail("eligibility-checks-out-of-bounds");
  const checks = value.checks.map((check) => {
    exactKeys(check, ELIGIBILITY_CHECK_FIELDS, "ui-eligibility-check");
    return {
      name: asText(check.name, "eligibility-check-name", 64, { singleLine: true }),
      met: asBoolean(check.met, "eligibility-check-met"),
      actual: asInt(check.actual, "eligibility-check-actual", { max: 1_000_000_000 }),
      required: asInt(check.required, "eligibility-check-required", { max: 1_000_000_000 }),
    };
  });
  assertOrdered(checks, (left, right) => compareText(left.name, right.name), "eligibility-checks");
  if (new Set(checks.map((check) => check.name)).size !== checks.length) fail("duplicate-eligibility-check");
  return { eligible: asBoolean(value.eligible, "eligible"), reasons, checks };
}

function makeRollback(value) {
  exactKeys(value, ROLLBACK_FIELDS, "ui-rollback");
  const eligible = asBoolean(value.eligible, "rollback-eligible");
  const reason = asNullableReason(value.reason);
  const appliedHash = value.appliedHash === null ? null : asHash(value.appliedHash, "applied-hash");
  if (eligible && (reason !== null || appliedHash === null)) fail("inconsistent-rollback-eligibility");
  return { eligible, reason, appliedHash };
}

function makeDetailOperation(value) {
  exactKeys(value, DETAIL_OPERATION_FIELDS, "ui-detail-operation");
  const status = asEnum(value.status, ["idle", "queued", "running", "completed", "failed", "accepted-terminal"], "operation-status");
  const requestId = value.requestId === null ? null : asId(value.requestId, "request-id");
  const reason = asNullableReason(value.reason);
  const updatedAt = value.updatedAt === null ? null : asTimestamp(value.updatedAt, "operation-updated-at");
  if (status === "idle" && (requestId !== null || reason !== null || updatedAt !== null)) fail("inconsistent-idle-operation");
  if (status !== "idle" && (requestId === null || updatedAt === null)) fail("inconsistent-active-operation");
  return { status, requestId, reason, updatedAt };
}

function makeDetailSummary(value) {
  exactKeys(value, DETAIL_SUMMARY_FIELDS, "ui-review-summary");
  exactKeys(value.target, DETAIL_TARGET_FIELDS, "ui-review-target");
  const currentHash = value.target.currentHash === "must-not-exist"
    ? value.target.currentHash
    : asHash(value.target.currentHash, "current-hash");
  exactKeys(value.tokenImpact, TOKEN_IMPACT_FIELDS, "ui-token-impact");
  return {
    state: asEnum(value.state, PROPOSAL_STATES, "proposal-state"),
    target: {
      relativePath: asRelativeTarget(value.target.relativePath),
      currentHash,
      proposedContentHash: asHash(value.target.proposedContentHash, "proposed-content-hash"),
    },
    effectiveMode: asEnum(value.effectiveMode, MODES, "effective-mode"),
    rationale: asText(value.rationale, "rationale", UI_PROTOCOL_LIMITS.rationaleBytes),
    risk: asEnum(value.risk, ["none", "low", "medium", "high", "critical"], "risk"),
    criticScoreBasisPoints: asInt(value.criticScoreBasisPoints, "critic-score", { max: 10_000 }),
    criticPassed: asBoolean(value.criticPassed, "critic-passed"),
    validDeterministic: asBoolean(value.validDeterministic, "valid-deterministic"),
    injectionFlagged: asBoolean(value.injectionFlagged, "injection-flagged"),
    tokenImpact: {
      estimatedTokens: asInt(value.tokenImpact.estimatedTokens, "estimated-tokens", { max: 1_000_000_000 }),
      budgetTokens: asInt(value.tokenImpact.budgetTokens, "budget-tokens", { max: 1_000_000_000 }),
    },
    eligibility: makeEligibility(value.eligibility),
    rollback: makeRollback(value.rollback),
    operation: makeDetailOperation(value.operation),
  };
}

function makeDiff(value) {
  exactKeys(value, DIFF_FIELDS, "ui-review-diff");
  if (!Array.isArray(value.lines) || value.lines.length > UI_PROTOCOL_LIMITS.diffLines) fail("diff-lines-out-of-bounds");
  const lines = value.lines.map((line) => asText(line, "diff-line", 1024, { singleLine: true }));
  if (lines.reduce((bytes, line) => bytes + Buffer.byteLength(line, "utf8"), 0) > UI_PROTOCOL_LIMITS.diffBytes) fail("diff-bytes-out-of-bounds");
  return {
    kind: asEnum(value.kind, ["unavailable", "unified", "new-file"], "diff-kind"),
    lines,
    overflow: makeOverflow(value.overflow, lines.length, "diff"),
  };
}

function makeEvidence(value) {
  exactKeys(value, EVIDENCE_FIELDS, "ui-evidence-entry");
  return {
    id: asHash(value.id, "evidence-id"),
    kind: asEnum(value.kind, RECEIPT_TYPES, "evidence-kind"),
    summary: asText(value.summary, "evidence-summary", UI_PROTOCOL_LIMITS.summaryBytes),
    occurredAt: asTimestamp(value.occurredAt, "evidence-occurred-at"),
    redacted: asBoolean(value.redacted, "evidence-redacted"),
  };
}

function makeAudit(value) {
  exactKeys(value, AUDIT_FIELDS, "ui-audit-entry");
  return {
    id: asHash(value.id, "audit-id"),
    kind: asEnum(value.kind, AUDIT_KINDS, "audit-kind"),
    summary: asText(value.summary, "audit-summary", UI_PROTOCOL_LIMITS.summaryBytes),
    timestamp: asTimestamp(value.timestamp, "audit-timestamp"),
  };
}

export function makeUiReviewDetail(value, expectedValue) {
  assertEnvelopeVersion(value, "projectionVersion", UI_PROJECTION_VERSION, "projection", "ui-review-detail");
  exactKeys(value, UI_REVIEW_DETAIL_FIELDS, "ui-review-detail");
  const expected = makeDetailContext(expectedValue);
  const projectionVersion = assertVersion(value.projectionVersion, UI_PROJECTION_VERSION, "projection");
  const projectFingerprint = asHash(value.projectFingerprint, "project-fingerprint");
  const stateRootIdentity = asHash(value.stateRootIdentity, "state-root-identity");
  const generation = asHash(value.generation, "generation");
  const revision = asInt(value.revision, "detail-revision", { max: 1_000_000 });
  if (projectFingerprint !== expected.projectFingerprint) fail("cross-project");
  if (stateRootIdentity !== expected.stateRootIdentity) fail("cross-root");
  if (generation !== expected.generation) fail("stale-generation");
  if (revision !== expected.detailRevision) fail("stale-detail-revision");
  const issuedAt = asTimestamp(value.issuedAt, "projection-issued-at");
  const expiresAt = asTimestamp(value.expiresAt, "projection-expires-at");
  assertProjectionTimes(issuedAt, expiresAt, expected.now);
  const evidence = (() => {
    if (!Array.isArray(value.evidence) || value.evidence.length > UI_PROTOCOL_LIMITS.evidenceEntries) fail("evidence-out-of-bounds");
    const clean = value.evidence.map(makeEvidence);
    assertOrdered(clean, (left, right) => right.occurredAt - left.occurredAt || compareText(left.id, right.id), "evidence");
    if (new Set(clean.map((entry) => entry.id)).size !== clean.length) fail("duplicate-evidence");
    return clean;
  })();
  const audit = (() => {
    if (!Array.isArray(value.audit) || value.audit.length > UI_PROTOCOL_LIMITS.auditEntries) fail("audit-out-of-bounds");
    const clean = value.audit.map(makeAudit);
    assertOrdered(clean, (left, right) => right.timestamp - left.timestamp || compareText(left.id, right.id), "audit");
    if (new Set(clean.map((entry) => entry.id)).size !== clean.length) fail("duplicate-audit");
    return clean;
  })();
  const allowedActions = (() => {
    if (!Array.isArray(value.allowedActions) || value.allowedActions.length > UI_PROTOCOL_LIMITS.allowedActions) fail("allowed-actions-out-of-bounds");
    const clean = value.allowedActions.map((action) => makeAllowedAction(action, {
      capabilities: expected.supportedCapabilities,
      expiresAt,
      now: expected.now,
    }));
    assertOrdered(clean, (left, right) => compareText(left.action, right.action), "allowed-actions");
    if (new Set(clean.map((entry) => entry.action)).size !== clean.length) fail("duplicate-allowed-action");
    return clean;
  })();
  exactKeys(value.overflow, DETAIL_OVERFLOW_FIELDS, "ui-review-detail-overflow");
  const overflow = {
    evidence: makeOverflow(value.overflow.evidence, evidence.length, "evidence"),
    audit: makeOverflow(value.overflow.audit, audit.length, "audit"),
    allowedActions: makeOverflow(value.overflow.allowedActions, allowedActions.length, "allowed-actions"),
  };
  const clean = {
    projectionVersion,
    projectFingerprint,
    stateRootIdentity,
    generation,
    proposalId: asId(value.proposalId, "proposal-id"),
    revision,
    issuedAt,
    expiresAt,
    summary: makeDetailSummary(value.summary),
    diff: makeDiff(value.diff),
    evidence,
    audit,
    allowedActions,
    overflow,
    detailHash: asHash(value.detailHash, "detail-hash"),
  };
  if (hashUiProtocol("review-detail", clean) !== clean.detailHash || clean.detailHash !== expected.detailHash) fail("detail-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > UI_PROTOCOL_LIMITS.detailBytes) fail("review-detail-footprint-exceeded");
  return deepFreeze(clean);
}

function makeOperationContext(value) {
  exactKeys(value, [
    "projectFingerprint", "stateRootIdentity", "generation", "projectionHash", "now", "supportedCapabilities", "grant",
  ], "ui-operation-context");
  const now = asTimestamp(value.now, "now");
  const supportedCapabilities = exactSortedList(value.supportedCapabilities, "capabilities", UI_CAPABILITIES, UI_PROTOCOL_LIMITS.capabilities, "unknown-capability");
  exactKeys(value.grant, ALLOWED_ACTION_FIELDS, "ui-operation-grant");
  if (!UI_OPERATION_ACTIONS.includes(value.grant.action)) fail("invalid-operation-grant-action");
  const grant = {
    action: value.grant.action,
    capability: asEnum(value.grant.capability, UI_CAPABILITIES, "operation-grant-capability"),
    nonce: asId(value.grant.nonce, "operation-grant-nonce"),
    expiresAt: asTimestamp(value.grant.expiresAt, "operation-grant-expires-at"),
  };
  if (UI_ACTION_CAPABILITIES[grant.action] !== grant.capability) fail("operation-grant-capability-mismatch");
  if (!supportedCapabilities.includes(grant.capability)) fail("unsupported-capability", grant.capability);
  if (grant.expiresAt <= now) fail("expired-operation-grant");
  return {
    projectFingerprint: asHash(value.projectFingerprint, "project-fingerprint"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "generation"),
    projectionHash: asHash(value.projectionHash, "projection-hash"),
    now,
    supportedCapabilities,
    grant,
  };
}

function asTargetHash(value, label) {
  return value === "must-not-exist" ? value : asHash(value, label);
}

function makeOperationPayload(action, value, now) {
  if (action === "snooze-proposal") {
    exactKeys(value, SNOOZE_PAYLOAD_FIELDS, "snooze-payload");
    const snoozedUntil = asTimestamp(value.snoozedUntil, "snoozed-until");
    if (snoozedUntil <= now || snoozedUntil - now > UI_PROTOCOL_LIMITS.snoozeMaxMs) fail("invalid-snooze-expiry");
    return {
      proposalId: asId(value.proposalId, "proposal-id"),
      targetHash: asTargetHash(value.targetHash, "target-hash"),
      proposedContentHash: asHash(value.proposedContentHash, "proposed-content-hash"),
      decisionVersion: asInt(value.decisionVersion, "decision-version", { min: 1, max: 1_000_000 }),
      snoozedUntil,
    };
  }
  if (action === "rollback-proposal") {
    exactKeys(value, ROLLBACK_PAYLOAD_FIELDS, "rollback-payload");
    return {
      proposalId: asId(value.proposalId, "proposal-id"),
      appliedHash: asHash(value.appliedHash, "applied-hash"),
      decisionVersion: asInt(value.decisionVersion, "decision-version", { min: 1, max: 1_000_000 }),
    };
  }
  if (action === "set-kill-switch") {
    exactKeys(value, SETTINGS_PAYLOAD_FIELDS, "kill-switch-payload");
    return {
      enabled: asBoolean(value.enabled, "kill-switch-enabled"),
      settingsVersion: asHash(value.settingsVersion, "settings-version"),
    };
  }
  if (action === "set-paused") {
    exactKeys(value, PAUSE_PAYLOAD_FIELDS, "pause-payload");
    return {
      paused: asBoolean(value.paused, "paused"),
      settingsVersion: asHash(value.settingsVersion, "settings-version"),
    };
  }
  if (action === "purge-scope") {
    exactKeys(value, PURGE_SCOPE_PAYLOAD_FIELDS, "purge-scope-payload");
    const scope = asEnum(value.scope, ["observations", "proposals", "project"], "purge-scope");
    const confirmation = asText(value.confirmation, "purge-confirmation", 64, { singleLine: true });
    if (confirmation !== `PURGE ${scope.toUpperCase()}`) fail("invalid-purge-confirmation");
    return { scope, confirmation };
  }
  if (action === "purge-all") {
    exactKeys(value, CONFIRMATION_PAYLOAD_FIELDS, "purge-all-payload");
    const confirmation = asText(value.confirmation, "purge-all-confirmation", 64, { singleLine: true });
    if (confirmation !== "PURGE ALL SELF-EVOLVE DATA") fail("invalid-purge-confirmation");
    return { confirmation };
  }
  if (action === "export-data") {
    exactKeys(value, EXPORT_PAYLOAD_FIELDS, "export-payload");
    const scope = asEnum(value.scope, ["observations", "proposals", "project", "all"], "export-scope");
    const confirmation = asText(value.confirmation, "export-confirmation", 64, { singleLine: true });
    if (confirmation !== "EXPORT SENSITIVE SELF-EVOLVE DATA") fail("invalid-export-confirmation");
    return { scope, confirmation };
  }
  if (action === "retry-bootstrap") {
    exactKeys(value, [], "retry-bootstrap-payload");
    return {};
  }
  fail("unknown-operation-action", String(action));
}

export function makeUiOperationRequest(value, expectedValue) {
  assertEnvelopeVersion(value, "operationProtocolVersion", UI_OPERATION_PROTOCOL_VERSION, "operation", "ui-operation-request");
  exactKeys(value, UI_OPERATION_REQUEST_FIELDS, "ui-operation-request");
  const expected = makeOperationContext(expectedValue);
  const operationProtocolVersion = assertVersion(value.operationProtocolVersion, UI_OPERATION_PROTOCOL_VERSION, "operation");
  const projectFingerprint = asHash(value.projectFingerprint, "project-fingerprint");
  const stateRootIdentity = asHash(value.stateRootIdentity, "state-root-identity");
  const generation = asHash(value.generation, "generation");
  const projectionHash = asHash(value.projectionHash, "projection-hash");
  if (projectFingerprint !== expected.projectFingerprint) fail("cross-project");
  if (stateRootIdentity !== expected.stateRootIdentity) fail("cross-root");
  if (generation !== expected.generation) fail("stale-generation");
  if (projectionHash !== expected.projectionHash) fail("stale-projection");
  if (!UI_OPERATION_ACTIONS.includes(value.action)) fail("unknown-operation-action", String(value.action));
  const action = value.action;
  const capability = asEnum(value.capability, UI_CAPABILITIES, "capability");
  if (UI_ACTION_CAPABILITIES[action] !== capability) fail("action-capability-mismatch");
  if (!expected.supportedCapabilities.includes(capability)) fail("unsupported-capability", capability);
  if (action !== expected.grant.action) fail("operation-grant-action-mismatch");
  if (capability !== expected.grant.capability) fail("operation-grant-capability-mismatch");
  if (value.actor !== "self-evolve-tui") fail("invalid-operation-actor");
  const issuedAt = asTimestamp(value.issuedAt, "operation-issued-at");
  const expiresAt = asTimestamp(value.expiresAt, "operation-expires-at");
  if (issuedAt > expected.now + UI_PROTOCOL_LIMITS.futureSkewMs) fail("future-operation");
  if (expiresAt <= expected.now) fail("expired-operation");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > UI_PROTOCOL_LIMITS.operationTtlMs) fail("invalid-operation-lifetime");
  if (expiresAt > expected.grant.expiresAt) fail("operation-exceeds-grant-expiry");
  const nonce = asId(value.nonce, "operation-nonce");
  if (nonce !== expected.grant.nonce) fail("operation-grant-nonce-mismatch");
  const clean = {
    operationProtocolVersion,
    requestId: asId(value.requestId, "request-id"),
    projectFingerprint,
    stateRootIdentity,
    generation,
    projectionHash,
    action,
    capability,
    actor: value.actor,
    issuedAt,
    expiresAt,
    nonce,
    payload: makeOperationPayload(action, value.payload, expected.now),
    operationHash: asHash(value.operationHash, "operation-hash"),
  };
  if (hashUiProtocol("operation-request", clean) !== clean.operationHash) fail("operation-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > UI_PROTOCOL_LIMITS.operationBytes) fail("operation-footprint-exceeded");
  return deepFreeze(clean);
}

function makeResponseContext(value) {
  exactKeys(value, [
    "projectFingerprint", "stateRootIdentity", "requestId", "action", "requestHash",
    "requestIssuedAt", "requestExpiresAt", "now",
  ], "ui-operation-response-context");
  const requestIssuedAt = asTimestamp(value.requestIssuedAt, "request-issued-at");
  const requestExpiresAt = asTimestamp(value.requestExpiresAt, "request-expires-at");
  if (requestExpiresAt <= requestIssuedAt || requestExpiresAt - requestIssuedAt > UI_PROTOCOL_LIMITS.operationTtlMs) fail("invalid-request-lifetime");
  return {
    projectFingerprint: asHash(value.projectFingerprint, "project-fingerprint"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    requestId: asId(value.requestId, "request-id"),
    action: asEnum(value.action, UI_OPERATION_ACTIONS, "operation-action"),
    requestHash: asHash(value.requestHash, "request-hash"),
    requestIssuedAt,
    requestExpiresAt,
    now: asTimestamp(value.now, "now"),
  };
}

export function makeUiOperationResponse(value, expectedValue) {
  assertEnvelopeVersion(value, "operationProtocolVersion", UI_OPERATION_PROTOCOL_VERSION, "operation", "ui-operation-response");
  exactKeys(value, UI_OPERATION_RESPONSE_FIELDS, "ui-operation-response");
  const expected = makeResponseContext(expectedValue);
  const operationProtocolVersion = assertVersion(value.operationProtocolVersion, UI_OPERATION_PROTOCOL_VERSION, "operation");
  const requestId = asId(value.requestId, "request-id");
  const projectFingerprint = asHash(value.projectFingerprint, "project-fingerprint");
  const stateRootIdentity = asHash(value.stateRootIdentity, "state-root-identity");
  const action = asEnum(value.action, UI_OPERATION_ACTIONS, "operation-action");
  const requestHash = asHash(value.requestHash, "request-hash");
  if (projectFingerprint !== expected.projectFingerprint) fail("cross-project");
  if (stateRootIdentity !== expected.stateRootIdentity) fail("cross-root");
  if (requestId !== expected.requestId) fail("request-id-mismatch");
  if (action !== expected.action) fail("response-action-mismatch");
  if (requestHash !== expected.requestHash) fail("request-hash-mismatch");
  const ok = asBoolean(value.ok, "response-ok");
  const status = asEnum(value.status, ["accepted", "rejected", "accepted-terminal"], "response-status");
  const reason = asNullableReason(value.reason);
  if (ok !== ["accepted", "accepted-terminal"].includes(status)) fail("inconsistent-response-status");
  if (status === "rejected" && !reason) fail("missing-response-reason");
  if (status !== "rejected" && reason !== null) fail("inconsistent-response-reason");
  if ((status === "accepted-terminal") !== (action === "purge-all" && ok)) fail("invalid-terminal-response");
  const processedAt = asTimestamp(value.processedAt, "processed-at");
  if (processedAt < expected.requestIssuedAt) fail("response-precedes-request");
  if (processedAt >= expected.requestExpiresAt) fail("response-after-request-expiry");
  if (processedAt > expected.now + UI_PROTOCOL_LIMITS.futureSkewMs) fail("future-response");
  const clean = {
    operationProtocolVersion,
    requestId,
    projectFingerprint,
    stateRootIdentity,
    action,
    requestHash,
    ok,
    status,
    processedAt,
    reason,
    responseHash: asHash(value.responseHash, "response-hash"),
  };
  if (hashUiProtocol("operation-response", clean) !== clean.responseHash) fail("response-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > UI_PROTOCOL_LIMITS.responseBytes) fail("response-footprint-exceeded");
  return deepFreeze(clean);
}

export function assertUiProjectionFootprint(indexValue, detailValues, expectedValue) {
  const expected = makeProjectionContext(expectedValue);
  const index = makeUiProjectionIndex(indexValue, expected);
  if (!Array.isArray(detailValues) || detailValues.length > UI_PROTOCOL_LIMITS.residentDetails) {
    fail("resident-details-out-of-bounds");
  }
  if (new Set(detailValues.map((detail) => detail?.proposalId)).size !== detailValues.length) fail("duplicate-review-detail");
  if (new Set(detailValues.map((detail) => detail?.detailHash)).size !== detailValues.length) fail("duplicate-review-detail-hash");
  const reviews = new Map(index.reviews.map((review) => [review.proposalId, review]));
  const details = detailValues.map((detail) => {
    const review = reviews.get(detail?.proposalId);
    if (!review) fail("unlisted-review-detail");
    const clean = makeUiReviewDetail(detail, {
      projectFingerprint: index.projectFingerprint,
      stateRootIdentity: index.stateRootIdentity,
      generation: index.generation,
      detailRevision: review.detailRevision,
      detailHash: review.detailHash,
      now: expected.now,
      supportedCapabilities: index.capabilities,
    });
    if (clean.summary.state !== review.state) fail("detail-state-mismatch");
    if (clean.summary.target.relativePath !== review.target) fail("detail-target-mismatch");
    if (clean.issuedAt < index.issuedAt || clean.expiresAt > index.expiresAt) fail("detail-lifetime-outside-index");
    return clean;
  });
  const bytes = Buffer.byteLength(canonicalUiJson(index), "utf8")
    + details.reduce((total, detail) => total + Buffer.byteLength(canonicalUiJson(detail), "utf8"), 0);
  if (bytes > UI_PROTOCOL_LIMITS.totalProjectionBytes) fail("total-projection-footprint-exceeded");
  return deepFreeze({ bytes, index, details });
}
