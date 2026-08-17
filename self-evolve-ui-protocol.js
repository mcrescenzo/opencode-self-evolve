import { createHash } from "node:crypto";
import { deepFreeze, makeApprovedGlobalRoot } from "./self-evolve-schemas.js";

export const UI_PROJECTION_VERSION = 1;
export const UI_DASHBOARD_VERSION = 3;
export const UI_DASHBOARD_VERSIONS = Object.freeze([1, 2, UI_DASHBOARD_VERSION]);
export const UI_OPERATION_PROTOCOL_VERSION = 2;
export const GLOBAL_BRIDGE_SCHEMA_VERSION = 1;
export const GLOBAL_PROJECTION_VERSION = 1;
export const GLOBAL_OPERATION_PROTOCOL_VERSION = 1;
export const PROJECT_PARTICIPATION_VERSION = 1;
export const GLOBAL_CAPABILITIES = Object.freeze([
  "global-action-grant-v1",
  "global-action-request-v1",
  "global-generality-v1",
  "global-recommendation-detail-v1",
  "global-recommendation-index-v1",
  "global-transaction-v1",
  "project-participation-v1",
]);
const GLOBAL_AUTHORITATIVE_CAPABILITIES = Object.freeze([
  "global-action-grant-v1",
  "global-action-request-v1",
  "global-generality-v1",
  "global-recommendation-detail-v1",
  "global-recommendation-index-v1",
  "global-transaction-v1",
  "project-participation-v1",
]);
export const GLOBAL_PROTOCOL_COMPATIBILITY = Object.freeze({
  native: "authoritative-global-v1",
  newTuiOldServer: "limited-new-tui-old-server",
  oldTuiNewServer: "limited-old-tui-new-server",
});
export const UI_CAPABILITIES = Object.freeze([
  "automatic-recommendations-control-v1",
  "legacy-decision-v1",
  "operation-export-v1",
  "operation-kill-switch-v1",
  "operation-purge-all-v1",
  "operation-purge-scope-v1",
  "operation-retry-bootstrap-v1",
  "operation-rollback-v1",
  "operation-snooze-v1",
  "projection-index-v1",
  "projection-review-detail-v1",
]);
const LEGACY_UI_CAPABILITIES = Object.freeze([
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
const ALL_UI_CAPABILITIES = Object.freeze([...new Set([
  ...UI_CAPABILITIES,
  ...LEGACY_UI_CAPABILITIES,
])].sort(compareText));
export const UI_DASHBOARD_CAPABILITIES = Object.freeze([
  "decision-feedback-v1",
  "operation-global-root-policy-v1",
  "project-participation-v1",
]);
const LEGACY_UI_DASHBOARD_CAPABILITIES = Object.freeze([
  "control-repo-mode-v1",
  "decision-feedback-v1",
  "operation-global-root-policy-v1",
  "project-analysis-control-v1",
]);
const UI_OPERATION_CAPABILITIES = Object.freeze(
  [...UI_CAPABILITIES, ...UI_DASHBOARD_CAPABILITIES].sort(compareText),
);
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
export const GLOBAL_PROTOCOL_LIMITS = Object.freeze({
  canonicalBytes: UI_PROTOCOL_LIMITS.canonicalBytes,
  capabilities: 16,
  recommendationIndexEntries: UI_PROTOCOL_LIMITS.reviewIndexEntries,
  availableActions: 3,
  diffLines: UI_PROTOCOL_LIMITS.diffLines,
  diffBytes: UI_PROTOCOL_LIMITS.diffBytes,
  evidenceSummaryEntries: 8,
  summaryBytes: UI_PROTOCOL_LIMITS.summaryBytes,
  rationaleBytes: UI_PROTOCOL_LIMITS.rationaleBytes,
  indexBytes: UI_PROTOCOL_LIMITS.indexBytes,
  detailBytes: UI_PROTOCOL_LIMITS.detailBytes,
  grantBytes: 4 * 1024,
  operationBytes: UI_PROTOCOL_LIMITS.operationBytes,
  responseBytes: UI_PROTOCOL_LIMITS.responseBytes,
  totalProjectionBytes: UI_PROTOCOL_LIMITS.totalProjectionBytes,
  residentDetails: UI_PROTOCOL_LIMITS.residentDetails,
  projectionTtlMs: UI_PROTOCOL_LIMITS.projectionTtlMs,
  operationTtlMs: UI_PROTOCOL_LIMITS.operationTtlMs,
  futureSkewMs: UI_PROTOCOL_LIMITS.futureSkewMs,
});

export const UI_ACTIONS = Object.freeze([
  "acknowledge-audit",
  "apply-proposal",
  "export-data",
  "purge-all",
  "purge-scope",
  "reject-proposal",
  "replace-global-root-policy",
  "retry-bootstrap",
  "rollback-proposal",
  "set-automatic-recommendations",
  "set-kill-switch",
  "set-permission",
  "set-repo-excluded",
  "snooze-proposal",
]);
export const UI_OPERATION_ACTIONS = Object.freeze([
  "export-data",
  "purge-all",
  "purge-scope",
  "replace-global-root-policy",
  "retry-bootstrap",
  "rollback-proposal",
  "set-automatic-recommendations",
  "set-kill-switch",
  "set-permission",
  "set-repo-excluded",
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
export const GLOBAL_RECOMMENDATION_INDEX_FIELDS = Object.freeze([
  "projectionVersion", "stateRootIdentity", "generation", "issuedAt", "expiresAt",
  "capabilities", "recommendations", "overflow", "indexHash",
]);
export const GLOBAL_RECOMMENDATION_DETAIL_FIELDS = Object.freeze([
  "projectionVersion", "stateRootIdentity", "generation", "recommendationId",
  "recommendationVersion", "supportSetHash", "targetBindingHash", "targetHash",
  "proposedContentHash", "priorState", "issuedAt", "expiresAt", "target", "support",
  "safety", "generality", "rationale", "diff", "evidenceSummary", "availableActions", "actionReasons", "detailHash",
]);
export const GLOBAL_ACTION_GRANT_FIELDS = Object.freeze([
  "grantVersion", "capability", "stateRootIdentity", "generation", "indexHash", "detailHash",
  "recommendationId", "recommendationVersion", "supportSetHash", "targetBindingHash",
  "targetHash", "proposedContentHash", "priorState", "action", "nonce", "issuedAt",
  "expiresAt", "grantHash",
]);
export const GLOBAL_ACTION_REQUEST_FIELDS = Object.freeze([
  "protocolVersion", "capability", "requestId", "stateRootIdentity", "actingProjectFingerprint",
  "actingHealthHash", "projectionGenerationHash", "indexHash", "detailHash", "grantHash",
  "recommendationId", "recommendationVersion", "supportSetHash", "targetBindingHash",
  "targetHash", "proposedContentHash", "priorState", "action", "actorRole", "issuedAt",
  "expiresAt", "nonce", "requestHash",
]);
export const GLOBAL_ACTION_RESPONSE_FIELDS = Object.freeze([
  "protocolVersion", "requestId", "stateRootIdentity", "recommendationId",
  "recommendationVersion", "action", "requestHash", "ok", "status", "processedAt",
  "reason", "responseHash",
]);
export const PROJECT_PARTICIPATION_FIELDS = Object.freeze([
  "participationVersion", "projectFingerprint", "stateRootIdentity", "generation", "indexHash",
  "recommendationId", "supportSetHash", "currentProjectContributed", "issuedAt", "expiresAt",
  "participationHash",
]);

const UI_PROTOCOL_OFFER_FIELDS = Object.freeze(["projectionVersions", "operationProtocolVersions", "capabilities"]);
const GLOBAL_PROTOCOL_OFFER_FIELDS = Object.freeze([
  "bridgeSchemaVersions", "projectionVersions", "operationProtocolVersions", "capabilities",
]);
const INDEX_STATUS_FIELDS = Object.freeze([
  "state", "reason", "automaticRecommendationsEnabled", "killSwitchActive",
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
const DASHBOARD_LAST_CYCLE_V3_FIELDS = Object.freeze([
  "outcome", "triggerClass", "observationCount", "eligibilityCount",
  "proposalId", "occurredAt", "reason",
]);
const DASHBOARD_USAGE_FIELDS = Object.freeze(["passive", "synthesis", "storage"]);
const DASHBOARD_USAGE_V3_FIELDS = Object.freeze(["provider", "synthesis", "storage"]);
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
const DASHBOARD_SETTINGS_V2_FIELDS = Object.freeze([
  ...DASHBOARD_SETTINGS_FIELDS, "globalSettingsVersion", "globalRootPolicy",
  "globalRootPolicyConfirmation", "globalRootPolicyAction",
]);
const DASHBOARD_SETTINGS_V3_FIELDS = Object.freeze([
  "automaticRecommendationsEnabled", "automationGeneration", "killSwitchActive",
  "repositoryExcluded", "consent", "approvedSkillFolderCount", "collectionSuggestions", "globalSettingsVersion",
  "globalRootPolicy", "globalRootPolicyConfirmation", "globalRootPolicyAction",
]);
const DASHBOARD_CONSENT_FIELDS = Object.freeze([
  "passiveCalls", "durableObservations", "sanitizedExcerpts", "crossRepoAggregation",
]);
const DASHBOARD_CONSENT_V3_FIELDS = Object.freeze([
  "durableObservations", "sanitizedExcerpts", "crossRepoAggregation",
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
const PERMISSION_PAYLOAD_FIELDS = Object.freeze(["permission", "enabled", "settingsVersion"]);
const PROJECT_EXCLUSION_PAYLOAD_FIELDS = Object.freeze(["excluded", "settingsVersion"]);
const ROOT_POLICY_PAYLOAD_FIELDS = Object.freeze([
  "roots", "creationRootPath", "confirmation", "settingsVersion",
]);
const ROOT_POLICY_ROOT_FIELDS = Object.freeze(["canonicalPath", "canUpdate", "canCreate"]);
const PURGE_SCOPE_PAYLOAD_FIELDS = Object.freeze(["scope", "confirmation"]);
const CONFIRMATION_PAYLOAD_FIELDS = Object.freeze(["confirmation"]);
const EXPORT_PAYLOAD_FIELDS = Object.freeze(["scope", "confirmation"]);
// Legacy dashboard versions remain parseable for read-only compatibility only.
const MODES = Object.freeze(["manual", "auto", "yolo"]);
const PROPOSAL_STATES = Object.freeze([
  "critic-pending", "pending", "approved", "rejected", "applied", "rolled-back", "superseded", "failed-closed",
]);
export const UI_DASHBOARD_AUTOMATION_STATES = Object.freeze([
  "terminal", "corrupt", "emergency-stop", "circuit-breaker", "excluded", "off",
  "setup-required", "running", "backoff", "budget", "quiet-period", "ready",
]);
const LEGACY_DASHBOARD_AUTOMATION_STATES = Object.freeze([
  "terminal", "corrupt", "emergency-stop", "circuit-breaker", "paused", "excluded",
  "on-demand", "setup-required", "running", "backoff", "budget", "quiet-period", "ready",
]);
export const UI_DASHBOARD_BLOCKER_DESTINATIONS = deepFreeze({
  "unsupported-host": { dashboard: "settings", section: "settings", anchor: "unsupported-host" },
  "state-root": { dashboard: "settings", section: "settings", anchor: "state-root" },
  "provider": { dashboard: "settings", section: "settings", anchor: "provider" },
  "first-run": { dashboard: "settings", section: "settings", anchor: "automatic-recommendations" },
  "restart-required": { dashboard: "settings", section: "settings", anchor: "restart-required" },
  "automatic-recommendations-off": { dashboard: "settings", section: "settings", anchor: "automatic-recommendations" },
  "observation-consent": { dashboard: "settings", section: "settings", anchor: "observation-consent" },
  "approved-skill-folders": { dashboard: "settings", section: "settings", anchor: "approved-skill-folders" },
  "corrupt-state": { dashboard: "activity-errors", section: "activity", filter: "errors" },
  "emergency-stop": { dashboard: "settings", section: "settings", anchor: "emergency-stop" },
  "circuit-breaker": { dashboard: "activity-errors", section: "activity", filter: "errors" },
  "repository-excluded": { dashboard: "settings", section: "settings", anchor: "project-scope" },
});
export const UI_DASHBOARD_BLOCKER_CODES = Object.freeze(Object.keys(UI_DASHBOARD_BLOCKER_DESTINATIONS));
const LEGACY_DASHBOARD_BLOCKER_DESTINATIONS = deepFreeze({
  ...UI_DASHBOARD_BLOCKER_DESTINATIONS,
  "passive-consent": { dashboard: "settings", section: "settings", anchor: "passive-consent" },
  "yolo-rollout": { dashboard: "settings", section: "settings", anchor: "yolo-rollout" },
  paused: { dashboard: "home", section: "home" },
});
export const UI_CONTROL_CENTER_SETTINGS_ANCHORS = Object.freeze([
  "setup", "automatic-recommendations", "privacy", "limits", "maintenance",
  ...new Set(Object.values(UI_DASHBOARD_BLOCKER_DESTINATIONS)
    .filter((entry) => entry.section === "settings")
    .map((entry) => entry.anchor)),
]);
// BH-4: the outcomes an evolution cycle itself can report. This is the exact set
// runEvolutionCycle emits as `cycleOutcome`; anything outside it is coerced to a
// failure label, so it must be named explicitly rather than sliced positionally
// out of UI_DASHBOARD_OUTCOMES.
export const UI_CYCLE_OUTCOMES = Object.freeze([
  "cursor-unchanged", "no-observations", "not-eligible", "valid-no-change",
  "recommendation-created", "applied", "deferred", "failed-closed", "failed",
  "automatic-disabled", "automatic-baselined", "observed-shadow", "drain-empty",
]);
export const UI_DASHBOARD_OUTCOMES = Object.freeze([
  ...UI_CYCLE_OUTCOMES,
  "rolled-back", "recommendation-approved", "recommendation-rejected",
  "recommendation-snoozed", "recommendation-acknowledged", "breaker-open",
  "breaker-recovered", "automatic-recommendations-on", "automatic-recommendations-off", "emergency-stop-enabled",
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
  "future-evidence-only",
  "startup-pending", "setup-required", "restart-required", "unsupported-host", "corrupt-state",
  "emergency-stop", "automatic-recommendations-off", "repository-excluded", "unknown",
]);
export const UI_ACTION_CAPABILITIES = Object.freeze({
  "acknowledge-audit": "projection-review-detail-v1",
  "apply-proposal": "legacy-decision-v1",
  "export-data": "operation-export-v1",
  "purge-all": "operation-purge-all-v1",
  "purge-scope": "operation-purge-scope-v1",
  "reject-proposal": "legacy-decision-v1",
  "replace-global-root-policy": "operation-global-root-policy-v1",
  "retry-bootstrap": "operation-retry-bootstrap-v1",
  "rollback-proposal": "operation-rollback-v1",
  "set-automatic-recommendations": "automatic-recommendations-control-v1",
  "set-kill-switch": "operation-kill-switch-v1",
  "set-permission": "automatic-recommendations-control-v1",
  "set-repo-excluded": "automatic-recommendations-control-v1",
  "snooze-proposal": "operation-snooze-v1",
});
const LEGACY_UI_ACTION_CAPABILITIES = Object.freeze({
  "set-paused": "operation-pause-v1",
  "set-repo-mode": "legacy-control-v1",
});
const ALL_UI_ACTION_CAPABILITIES = Object.freeze({
  ...UI_ACTION_CAPABILITIES,
  ...LEGACY_UI_ACTION_CAPABILITIES,
});
const ALL_UI_ACTIONS = Object.freeze(Object.keys(ALL_UI_ACTION_CAPABILITIES).sort(compareText));
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
  "dashboard-v3": "self-evolve-ui-dashboard-v3",
  "review-detail": "self-evolve-ui-review-detail-v1",
  "operation-request": "self-evolve-ui-operation-request-v2",
  "operation-response": "self-evolve-ui-operation-response-v2",
});
const GLOBAL_HASH_DOMAINS = Object.freeze({
  "recommendation-index": ["self-evolve-global-recommendation-index-v1", "indexHash"],
  "recommendation-detail": ["self-evolve-global-recommendation-detail-v1", "detailHash"],
  "action-grant": ["self-evolve-global-action-grant-v1", "grantHash"],
  "action-request": ["self-evolve-global-action-request-v1", "requestHash"],
  "action-response": ["self-evolve-global-action-response-v1", "responseHash"],
  "project-participation": ["self-evolve-project-participation-v1", "participationHash"],
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
  const domain = kind === "dashboard" && value?.dashboardVersion === 3
    ? HASH_DOMAINS["dashboard-v3"]
    : kind === "dashboard" && value?.dashboardVersion === 2
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

export function hashGlobalProtocol(kind, value) {
  const entry = GLOBAL_HASH_DOMAINS[kind];
  if (!entry) fail("unknown-global-protocol-kind", String(kind));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("canonical-object");
  const [domain, omittedField] = entry;
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== omittedField));
  return createHash("sha256").update(`${domain}\n${canonicalUiJson(body)}`).digest("hex");
}

function asOpaqueUuid(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    fail(`invalid-${label}`);
  }
  return value;
}

function asUtcDay(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) fail(`invalid-${label}`);
  return value;
}

const GLOBAL_RECOMMENDATION_STATES = Object.freeze([
  "critic-pending", "pending", "approved", "applied", "undo-approved", "rejected",
  "rolled-back", "superseded", "failed-closed",
]);
const GLOBAL_ACTIONS = Object.freeze(["apply", "reject", "undo"]);
const GLOBAL_ACTION_REASON_FIELDS = GLOBAL_ACTIONS;
const GLOBAL_ACTION_PRIOR_STATES = Object.freeze({ apply: "pending", reject: "pending", undo: "applied" });
const GLOBAL_TARGET_KINDS = Object.freeze(["existing-global-skill", "new-global-skill"]);
const GLOBAL_TARGET_FIELDS = Object.freeze(["kind", "label"]);
const GLOBAL_INDEX_SUPPORT_FIELDS = Object.freeze([
  "tier", "independentDomainCount", "independentIncidentCount", "occurrenceCount",
]);
const GLOBAL_DETAIL_SUPPORT_FIELDS = Object.freeze([
  ...GLOBAL_INDEX_SUPPORT_FIELDS, "firstSeenDay", "lastSeenDay",
]);
const GLOBAL_DATES_FIELDS = Object.freeze(["firstSeenDay", "lastSeenDay", "synthesizedAt", "updatedAt"]);
const GLOBAL_SAFETY_FIELDS = Object.freeze([
  "criticScoreBasisPoints", "criticPassed", "validDeterministic",
]);
const GLOBAL_GENERALITY_FIELDS = Object.freeze(["passed", "basis"]);
const GLOBAL_INDEX_ENTRY_FIELDS = Object.freeze([
  "recommendationId", "recommendationVersion", "supportSetHash", "state", "target", "support", "dates",
  "safety", "availableActions", "detailHash",
]);
const GLOBAL_EVIDENCE_SUMMARY_FIELDS = Object.freeze(["kind", "count"]);

function makeGlobalTarget(value) {
  exactKeys(value, GLOBAL_TARGET_FIELDS, "global-target");
  const label = asText(value.label, "global-target-label", 128, { singleLine: true });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(label)) fail("invalid-global-target-label");
  return { kind: asEnum(value.kind, GLOBAL_TARGET_KINDS, "global-target-kind"), label };
}

function makeGlobalSupport(value, { dates = false } = {}) {
  exactKeys(value, dates ? GLOBAL_DETAIL_SUPPORT_FIELDS : GLOBAL_INDEX_SUPPORT_FIELDS, "global-support");
  const output = {
    tier: asEnum(value.tier, ["single-domain", "distributed"], "global-support-tier"),
    independentDomainCount: asInt(value.independentDomainCount, "global-support-domain-count", { max: 1_000_000 }),
    independentIncidentCount: asInt(value.independentIncidentCount, "global-support-incident-count", { max: 1_000_000 }),
    occurrenceCount: asInt(value.occurrenceCount, "global-support-occurrence-count", { max: 1_000_000_000 }),
  };
  if (dates) {
    output.firstSeenDay = asUtcDay(value.firstSeenDay, "global-support-first-seen-day");
    output.lastSeenDay = asUtcDay(value.lastSeenDay, "global-support-last-seen-day");
    if (output.lastSeenDay < output.firstSeenDay) fail("global-support-date-order");
  }
  return output;
}

function makeGlobalSafety(value) {
  exactKeys(value, GLOBAL_SAFETY_FIELDS, "global-safety");
  return {
    criticScoreBasisPoints: asInt(value.criticScoreBasisPoints, "global-critic-score", { max: 10_000 }),
    criticPassed: asBoolean(value.criticPassed, "global-critic-passed"),
    validDeterministic: asBoolean(value.validDeterministic, "global-deterministic-valid"),
  };
}

function makeGlobalGenerality(value) {
  exactKeys(value, GLOBAL_GENERALITY_FIELDS, "global-generality");
  const passed = asBoolean(value.passed, "global-generality-passed");
  if (!passed) fail("global-generality-not-passed");
  return {
    passed,
    basis: asEnum(value.basis, ["deterministic-generality-gate-v1"], "global-generality-basis"),
  };
}

function makeGlobalActions(value, state) {
  if (!Array.isArray(value) || value.length > GLOBAL_PROTOCOL_LIMITS.availableActions) fail("global-actions-out-of-bounds");
  const actions = value.map((action) => asEnum(action, GLOBAL_ACTIONS, "global-action"));
  assertOrdered(actions, compareText, "global-actions");
  if (new Set(actions).size !== actions.length) fail("global-actions-duplicate");
  const allowed = state === "pending" ? new Set(["apply", "reject"])
    : state === "superseded" ? new Set(["reject"])
      : state === "applied" ? new Set(["undo"]) : new Set();
  if (actions.some((action) => !allowed.has(action))) fail("global-action-state-mismatch");
  return actions;
}

function makeGlobalActionReasons(value, availableActions) {
  exactKeys(value, GLOBAL_ACTION_REASON_FIELDS, "global-action-reasons");
  const available = new Set(availableActions);
  return Object.fromEntries(GLOBAL_ACTIONS.map((action) => {
    const reason = value[action];
    if (available.has(action)) {
      if (reason !== null) fail("global-action-available-with-reason");
      return [action, null];
    }
    const clean = asText(reason, `global-${action}-reason`, 128, { singleLine: true });
    if (!/^[a-z][a-z0-9-]{0,127}$/u.test(clean)) fail("invalid-global-action-reason");
    return [action, clean];
  }));
}

function makeGlobalIndexEntry(value) {
  exactKeys(value, GLOBAL_INDEX_ENTRY_FIELDS, "global-recommendation-index-entry");
  const state = asEnum(value.state, GLOBAL_RECOMMENDATION_STATES, "global-recommendation-state");
  exactKeys(value.dates, GLOBAL_DATES_FIELDS, "global-recommendation-dates");
  const dates = {
    firstSeenDay: asUtcDay(value.dates.firstSeenDay, "global-first-seen-day"),
    lastSeenDay: asUtcDay(value.dates.lastSeenDay, "global-last-seen-day"),
    synthesizedAt: asTimestamp(value.dates.synthesizedAt, "global-synthesized-at"),
    updatedAt: asTimestamp(value.dates.updatedAt, "global-updated-at"),
  };
  if (dates.lastSeenDay < dates.firstSeenDay || dates.updatedAt < dates.synthesizedAt) fail("global-recommendation-date-order");
  return {
    recommendationId: asHash(value.recommendationId, "global-recommendation-id"),
    recommendationVersion: asInt(value.recommendationVersion, "global-recommendation-version", { min: 1, max: 1_000_000 }),
    supportSetHash: asHash(value.supportSetHash, "global-support-set-hash"),
    state,
    target: makeGlobalTarget(value.target),
    support: makeGlobalSupport(value.support),
    dates,
    safety: makeGlobalSafety(value.safety),
    availableActions: makeGlobalActions(value.availableActions, state),
    detailHash: asHash(value.detailHash, "global-detail-hash"),
  };
}

function makeGlobalProjectionContext(value) {
  exactKeys(value, ["stateRootIdentity", "generation", "now", "supportedCapabilities"], "global-projection-context");
  return {
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "global-generation"),
    now: asTimestamp(value.now, "now"),
    supportedCapabilities: exactSortedList(
      value.supportedCapabilities,
      "global-capabilities",
      GLOBAL_CAPABILITIES,
      GLOBAL_PROTOCOL_LIMITS.capabilities,
      "unknown-global-capability",
    ),
  };
}

function assertGlobalProjectionTimes(issuedAt, expiresAt, now) {
  if (issuedAt > now + GLOBAL_PROTOCOL_LIMITS.futureSkewMs) fail("future-global-projection");
  if (expiresAt <= now) fail("expired-global-projection");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > GLOBAL_PROTOCOL_LIMITS.projectionTtlMs) {
    fail("invalid-global-projection-lifetime");
  }
}

export function makeGlobalRecommendationIndex(value, expectedValue) {
  assertEnvelopeVersion(value, "projectionVersion", GLOBAL_PROJECTION_VERSION, "global-projection", "global-recommendation-index");
  exactKeys(value, GLOBAL_RECOMMENDATION_INDEX_FIELDS, "global-recommendation-index");
  const expected = makeGlobalProjectionContext(expectedValue);
  const stateRootIdentity = asHash(value.stateRootIdentity, "state-root-identity");
  const generation = asHash(value.generation, "global-generation");
  if (stateRootIdentity !== expected.stateRootIdentity) fail("cross-root");
  if (generation !== expected.generation) fail("stale-global-generation");
  const issuedAt = asTimestamp(value.issuedAt, "global-projection-issued-at");
  const expiresAt = asTimestamp(value.expiresAt, "global-projection-expires-at");
  assertGlobalProjectionTimes(issuedAt, expiresAt, expected.now);
  const capabilities = exactSortedList(
    value.capabilities,
    "global-capabilities",
    GLOBAL_CAPABILITIES,
    GLOBAL_PROTOCOL_LIMITS.capabilities,
    "unknown-global-capability",
  );
  if (capabilities.some((capability) => !expected.supportedCapabilities.includes(capability))) fail("unsupported-global-capability");
  if (!Array.isArray(value.recommendations)
      || value.recommendations.length > GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries) {
    fail("global-recommendations-out-of-bounds");
  }
  const recommendations = value.recommendations.map(makeGlobalIndexEntry);
  assertOrdered(recommendations, (left, right) => right.dates.updatedAt - left.dates.updatedAt
    || compareText(left.recommendationId, right.recommendationId), "global-recommendations");
  if (new Set(recommendations.map((entry) => entry.recommendationId)).size !== recommendations.length) {
    fail("duplicate-global-recommendation");
  }
  const clean = {
    projectionVersion: GLOBAL_PROJECTION_VERSION,
    stateRootIdentity,
    generation,
    issuedAt,
    expiresAt,
    capabilities,
    recommendations,
    overflow: makeOverflow(value.overflow, recommendations.length, "global-recommendations"),
    indexHash: asHash(value.indexHash, "global-index-hash"),
  };
  if (hashGlobalProtocol("recommendation-index", clean) !== clean.indexHash) fail("global-index-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > GLOBAL_PROTOCOL_LIMITS.indexBytes) fail("global-index-footprint-exceeded");
  return deepFreeze(clean);
}

function makeGlobalDetailContext(value) {
  exactKeys(value, [
    "stateRootIdentity", "generation", "recommendationId",
    "recommendationVersion", "detailHash", "now",
  ], "global-detail-context");
  return {
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "global-generation"),
    recommendationId: asHash(value.recommendationId, "global-recommendation-id"),
    recommendationVersion: asInt(value.recommendationVersion, "global-recommendation-version", { min: 1, max: 1_000_000 }),
    detailHash: asHash(value.detailHash, "global-detail-hash"),
    now: asTimestamp(value.now, "now"),
  };
}

function makeGlobalDiff(value) {
  exactKeys(value, DIFF_FIELDS, "global-diff");
  if (!Array.isArray(value.lines) || value.lines.length > GLOBAL_PROTOCOL_LIMITS.diffLines) fail("global-diff-lines-out-of-bounds");
  const lines = value.lines.map((line) => asText(line, "global-diff-line", 1024, { singleLine: true }));
  if (lines.reduce((bytes, line) => bytes + Buffer.byteLength(line, "utf8"), 0) > GLOBAL_PROTOCOL_LIMITS.diffBytes) {
    fail("global-diff-bytes-out-of-bounds");
  }
  return {
    kind: asEnum(value.kind, ["unavailable", "unified", "new-file"], "global-diff-kind"),
    lines,
    overflow: makeOverflow(value.overflow, lines.length, "global-diff"),
  };
}

export function makeGlobalRecommendationDetail(value, expectedValue) {
  assertEnvelopeVersion(value, "projectionVersion", GLOBAL_PROJECTION_VERSION, "global-projection", "global-recommendation-detail");
  exactKeys(value, GLOBAL_RECOMMENDATION_DETAIL_FIELDS, "global-recommendation-detail");
  const expected = makeGlobalDetailContext(expectedValue);
  const stateRootIdentity = asHash(value.stateRootIdentity, "state-root-identity");
  const generation = asHash(value.generation, "global-generation");
  const recommendationId = asHash(value.recommendationId, "global-recommendation-id");
  const recommendationVersion = asInt(value.recommendationVersion, "global-recommendation-version", { min: 1, max: 1_000_000 });
  if (stateRootIdentity !== expected.stateRootIdentity) fail("cross-root");
  if (generation !== expected.generation) fail("stale-global-generation");
  if (recommendationId !== expected.recommendationId || recommendationVersion !== expected.recommendationVersion) {
    fail("stale-global-recommendation");
  }
  const issuedAt = asTimestamp(value.issuedAt, "global-detail-issued-at");
  const expiresAt = asTimestamp(value.expiresAt, "global-detail-expires-at");
  assertGlobalProjectionTimes(issuedAt, expiresAt, expected.now);
  const priorState = asEnum(value.priorState, GLOBAL_RECOMMENDATION_STATES, "global-prior-state");
  if (!Array.isArray(value.evidenceSummary)
      || value.evidenceSummary.length > GLOBAL_PROTOCOL_LIMITS.evidenceSummaryEntries) {
    fail("global-evidence-summary-out-of-bounds");
  }
  const evidenceSummary = value.evidenceSummary.map((entry) => {
    exactKeys(entry, GLOBAL_EVIDENCE_SUMMARY_FIELDS, "global-evidence-summary-entry");
    return {
      kind: asEnum(entry.kind, ["independent-domains", "independent-incidents", "occurrences"], "global-evidence-summary-kind"),
      count: asInt(entry.count, "global-evidence-summary-count", { max: 1_000_000_000 }),
    };
  });
  assertOrdered(evidenceSummary, (left, right) => compareText(left.kind, right.kind), "global-evidence-summary");
  if (new Set(evidenceSummary.map((entry) => entry.kind)).size !== evidenceSummary.length) fail("global-evidence-summary-duplicate");
  const availableActions = makeGlobalActions(value.availableActions, priorState);
  const clean = {
    projectionVersion: GLOBAL_PROJECTION_VERSION,
    stateRootIdentity,
    generation,
    recommendationId,
    recommendationVersion,
    supportSetHash: asHash(value.supportSetHash, "global-support-set-hash"),
    targetBindingHash: asHash(value.targetBindingHash, "global-target-binding-hash"),
    targetHash: asTargetHash(value.targetHash, "global-target-hash"),
    proposedContentHash: asHash(value.proposedContentHash, "global-proposed-content-hash"),
    priorState,
    issuedAt,
    expiresAt,
    target: makeGlobalTarget(value.target),
    support: makeGlobalSupport(value.support, { dates: true }),
    safety: makeGlobalSafety(value.safety),
    generality: makeGlobalGenerality(value.generality),
    rationale: asText(value.rationale, "global-rationale", GLOBAL_PROTOCOL_LIMITS.rationaleBytes),
    diff: makeGlobalDiff(value.diff),
    evidenceSummary,
    availableActions,
    actionReasons: makeGlobalActionReasons(value.actionReasons, availableActions),
    detailHash: asHash(value.detailHash, "global-detail-hash"),
  };
  if (hashGlobalProtocol("recommendation-detail", clean) !== clean.detailHash
      || clean.detailHash !== expected.detailHash) fail("global-detail-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > GLOBAL_PROTOCOL_LIMITS.detailBytes) fail("global-detail-footprint-exceeded");
  return deepFreeze(clean);
}

function makeGlobalGrantContext(value) {
  exactKeys(value, ["stateRootIdentity", "generation", "indexHash", "detailHash", "now"], "global-grant-context");
  return {
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "global-generation"),
    indexHash: asHash(value.indexHash, "global-index-hash"),
    detailHash: asHash(value.detailHash, "global-detail-hash"),
    now: asTimestamp(value.now, "now"),
  };
}

export function makeGlobalActionGrant(value, expectedValue) {
  exactKeys(value, GLOBAL_ACTION_GRANT_FIELDS, "global-action-grant");
  const expected = makeGlobalGrantContext(expectedValue);
  const action = asEnum(value.action, GLOBAL_ACTIONS, "global-action");
  const priorState = asEnum(value.priorState, GLOBAL_RECOMMENDATION_STATES, "global-prior-state");
  if (GLOBAL_ACTION_PRIOR_STATES[action] !== priorState) fail("global-action-state-mismatch");
  const issuedAt = asTimestamp(value.issuedAt, "global-grant-issued-at");
  const expiresAt = asTimestamp(value.expiresAt, "global-grant-expires-at");
  if (issuedAt > expected.now + GLOBAL_PROTOCOL_LIMITS.futureSkewMs || expiresAt <= expected.now
      || expiresAt <= issuedAt || expiresAt - issuedAt > GLOBAL_PROTOCOL_LIMITS.operationTtlMs) {
    fail("invalid-global-grant-lifetime");
  }
  const clean = {
    grantVersion: assertVersion(value.grantVersion, 1, "global-grant"),
    capability: asEnum(value.capability, ["global-action-grant-v1"], "global-grant-capability"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "global-generation"),
    indexHash: asHash(value.indexHash, "global-index-hash"),
    detailHash: asHash(value.detailHash, "global-detail-hash"),
    recommendationId: asHash(value.recommendationId, "global-recommendation-id"),
    recommendationVersion: asInt(value.recommendationVersion, "global-recommendation-version", { min: 1, max: 1_000_000 }),
    supportSetHash: asHash(value.supportSetHash, "global-support-set-hash"),
    targetBindingHash: asHash(value.targetBindingHash, "global-target-binding-hash"),
    targetHash: asTargetHash(value.targetHash, "global-target-hash"),
    proposedContentHash: asHash(value.proposedContentHash, "global-proposed-content-hash"),
    priorState,
    action,
    nonce: asOpaqueUuid(value.nonce, "global-grant-nonce"),
    issuedAt,
    expiresAt,
    grantHash: asHash(value.grantHash, "global-grant-hash"),
  };
  for (const field of ["stateRootIdentity", "generation", "indexHash", "detailHash"]) {
    if (clean[field] !== expected[field]) fail(`stale-global-${field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  if (hashGlobalProtocol("action-grant", clean) !== clean.grantHash) fail("global-grant-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > GLOBAL_PROTOCOL_LIMITS.grantBytes) fail("global-grant-footprint-exceeded");
  return deepFreeze(clean);
}

export function makeGlobalActionRequestEnvelope(value, expectedValue) {
  exactKeys(value, GLOBAL_ACTION_REQUEST_FIELDS, "global-action-request");
  exactKeys(expectedValue, ["now", "stateRootIdentity", "grant"], "global-action-request-context");
  const now = asTimestamp(expectedValue.now, "now");
  const expectedRoot = asHash(expectedValue.stateRootIdentity, "state-root-identity");
  const grant = makeGlobalActionGrant(expectedValue.grant, {
    stateRootIdentity: expectedValue.grant?.stateRootIdentity,
    generation: expectedValue.grant?.generation,
    indexHash: expectedValue.grant?.indexHash,
    detailHash: expectedValue.grant?.detailHash,
    now,
  });
  const issuedAt = asTimestamp(value.issuedAt, "global-request-issued-at");
  const expiresAt = asTimestamp(value.expiresAt, "global-request-expires-at");
  if (issuedAt > now + GLOBAL_PROTOCOL_LIMITS.futureSkewMs || expiresAt <= now
      || expiresAt <= issuedAt || expiresAt - issuedAt > GLOBAL_PROTOCOL_LIMITS.operationTtlMs
      || expiresAt > grant.expiresAt) fail("invalid-global-request-lifetime");
  const clean = {
    protocolVersion: assertVersion(value.protocolVersion, GLOBAL_OPERATION_PROTOCOL_VERSION, "global-operation"),
    capability: asEnum(value.capability, ["global-action-request-v1"], "global-request-capability"),
    requestId: asOpaqueUuid(value.requestId, "global-request-id"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    actingProjectFingerprint: asHash(value.actingProjectFingerprint, "acting-project-fingerprint"),
    actingHealthHash: asHash(value.actingHealthHash, "acting-health-hash"),
    projectionGenerationHash: asHash(value.projectionGenerationHash, "global-generation"),
    indexHash: asHash(value.indexHash, "global-index-hash"),
    detailHash: asHash(value.detailHash, "global-detail-hash"),
    grantHash: asHash(value.grantHash, "global-grant-hash"),
    recommendationId: asHash(value.recommendationId, "global-recommendation-id"),
    recommendationVersion: asInt(value.recommendationVersion, "global-recommendation-version", { min: 1, max: 1_000_000 }),
    supportSetHash: asHash(value.supportSetHash, "global-support-set-hash"),
    targetBindingHash: asHash(value.targetBindingHash, "global-target-binding-hash"),
    targetHash: asTargetHash(value.targetHash, "global-target-hash"),
    proposedContentHash: asHash(value.proposedContentHash, "global-proposed-content-hash"),
    priorState: asEnum(value.priorState, GLOBAL_RECOMMENDATION_STATES, "global-prior-state"),
    action: asEnum(value.action, GLOBAL_ACTIONS, "global-action"),
    actorRole: asEnum(value.actorRole, ["operator"], "global-actor-role"),
    issuedAt,
    expiresAt,
    nonce: asOpaqueUuid(value.nonce, "global-request-nonce"),
    requestHash: asHash(value.requestHash, "global-request-hash"),
  };
  if (clean.stateRootIdentity !== expectedRoot) fail("cross-root");
  const bindings = {
    projectionGenerationHash: "generation",
    indexHash: "indexHash",
    detailHash: "detailHash",
    grantHash: "grantHash",
    recommendationId: "recommendationId",
    recommendationVersion: "recommendationVersion",
    supportSetHash: "supportSetHash",
    targetBindingHash: "targetBindingHash",
    targetHash: "targetHash",
    proposedContentHash: "proposedContentHash",
    priorState: "priorState",
    action: "action",
    nonce: "nonce",
  };
  for (const [requestField, grantField] of Object.entries(bindings)) {
    if (clean[requestField] !== grant[grantField]) fail("global-request-grant-mismatch", requestField);
  }
  if (hashGlobalProtocol("action-request", clean) !== clean.requestHash) fail("global-request-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > GLOBAL_PROTOCOL_LIMITS.operationBytes) fail("global-request-footprint-exceeded");
  return deepFreeze(clean);
}

export function makeGlobalActionResponse(value, expectedValue) {
  exactKeys(value, GLOBAL_ACTION_RESPONSE_FIELDS, "global-action-response");
  exactKeys(expectedValue, [
    "stateRootIdentity", "requestId", "recommendationId", "recommendationVersion",
    "action", "requestHash", "requestIssuedAt", "requestExpiresAt", "now",
  ], "global-action-response-context");
  const processedAt = asTimestamp(value.processedAt, "global-response-processed-at");
  const requestIssuedAt = asTimestamp(expectedValue.requestIssuedAt, "global-request-issued-at");
  const requestExpiresAt = asTimestamp(expectedValue.requestExpiresAt, "global-request-expires-at");
  if (processedAt < requestIssuedAt || processedAt >= requestExpiresAt
      || processedAt > asTimestamp(expectedValue.now, "now") + GLOBAL_PROTOCOL_LIMITS.futureSkewMs) {
    fail("invalid-global-response-time");
  }
  const ok = asBoolean(value.ok, "global-response-ok");
  const status = asEnum(value.status, ["accepted", "rejected"], "global-response-status");
  const reason = asNullableReason(value.reason);
  if (ok !== (status === "accepted") || (ok ? reason !== null : !reason)) fail("inconsistent-global-response");
  const clean = {
    protocolVersion: assertVersion(value.protocolVersion, GLOBAL_OPERATION_PROTOCOL_VERSION, "global-operation"),
    requestId: asOpaqueUuid(value.requestId, "global-request-id"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    recommendationId: asHash(value.recommendationId, "global-recommendation-id"),
    recommendationVersion: asInt(value.recommendationVersion, "global-recommendation-version", { min: 1, max: 1_000_000 }),
    action: asEnum(value.action, GLOBAL_ACTIONS, "global-action"),
    requestHash: asHash(value.requestHash, "global-request-hash"),
    ok,
    status,
    processedAt,
    reason,
    responseHash: asHash(value.responseHash, "global-response-hash"),
  };
  for (const field of ["stateRootIdentity", "requestId", "recommendationId", "recommendationVersion", "action", "requestHash"]) {
    if (clean[field] !== expectedValue[field]) fail("global-response-request-mismatch", field);
  }
  if (hashGlobalProtocol("action-response", clean) !== clean.responseHash) fail("global-response-hash-mismatch");
  if (Buffer.byteLength(canonicalUiJson(clean), "utf8") > GLOBAL_PROTOCOL_LIMITS.responseBytes) fail("global-response-footprint-exceeded");
  return deepFreeze(clean);
}

export function makeProjectParticipationSidecar(value, expectedValue) {
  exactKeys(value, PROJECT_PARTICIPATION_FIELDS, "project-participation");
  exactKeys(expectedValue, [
    "projectFingerprint", "stateRootIdentity", "generation", "indexHash", "recommendationId",
    "supportSetHash", "now",
  ], "project-participation-context");
  const issuedAt = asTimestamp(value.issuedAt, "participation-issued-at");
  const expiresAt = asTimestamp(value.expiresAt, "participation-expires-at");
  assertGlobalProjectionTimes(issuedAt, expiresAt, asTimestamp(expectedValue.now, "now"));
  const clean = {
    participationVersion: assertVersion(value.participationVersion, PROJECT_PARTICIPATION_VERSION, "project-participation"),
    projectFingerprint: asHash(value.projectFingerprint, "project-fingerprint"),
    stateRootIdentity: asHash(value.stateRootIdentity, "state-root-identity"),
    generation: asHash(value.generation, "global-generation"),
    indexHash: asHash(value.indexHash, "global-index-hash"),
    recommendationId: asHash(value.recommendationId, "global-recommendation-id"),
    supportSetHash: asHash(value.supportSetHash, "global-support-set-hash"),
    currentProjectContributed: asBoolean(value.currentProjectContributed, "current-project-contributed"),
    issuedAt,
    expiresAt,
    participationHash: asHash(value.participationHash, "participation-hash"),
  };
  for (const field of ["projectFingerprint", "stateRootIdentity", "generation", "indexHash", "recommendationId", "supportSetHash"]) {
    if (clean[field] !== expectedValue[field]) fail("project-participation-binding-mismatch", field);
  }
  if (hashGlobalProtocol("project-participation", clean) !== clean.participationHash) fail("participation-hash-mismatch");
  return deepFreeze(clean);
}

export function makeGlobalProtocolOffer(value) {
  exactKeys(value, GLOBAL_PROTOCOL_OFFER_FIELDS, "global-protocol-offer");
  return deepFreeze({
    bridgeSchemaVersions: exactSortedList(value.bridgeSchemaVersions, "global-bridge-versions", [GLOBAL_BRIDGE_SCHEMA_VERSION], 4, "unsupported-global-bridge-version"),
    projectionVersions: exactSortedList(value.projectionVersions, "global-projection-versions", [GLOBAL_PROJECTION_VERSION], 4, "unsupported-global-projection-version"),
    operationProtocolVersions: exactSortedList(value.operationProtocolVersions, "global-operation-versions", [GLOBAL_OPERATION_PROTOCOL_VERSION], 4, "unsupported-global-operation-version"),
    capabilities: exactSortedList(value.capabilities, "global-capabilities", GLOBAL_CAPABILITIES, GLOBAL_PROTOCOL_LIMITS.capabilities, "unknown-global-capability"),
  });
}

function makeGlobalPeerOffer(value) {
  exactKeys(value, GLOBAL_PROTOCOL_OFFER_FIELDS, "global-protocol-peer-offer");
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length > GLOBAL_PROTOCOL_LIMITS.capabilities) fail("global-capabilities-out-of-bounds");
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(capability)) fail("invalid-global-peer-capability");
  }
  assertOrdered(capabilities, compareText, "global-capabilities");
  if (new Set(capabilities).size !== capabilities.length) fail("global-capabilities-duplicate");
  return {
    bridgeSchemaVersions: makePeerVersionList(value.bridgeSchemaVersions, "global-bridge-versions"),
    projectionVersions: makePeerVersionList(value.projectionVersions, "global-projection-versions"),
    operationProtocolVersions: makePeerVersionList(value.operationProtocolVersions, "global-operation-versions"),
    capabilities,
  };
}

function limitedGlobalProtocol(label, reason) {
  return deepFreeze({
    mode: "limited",
    label,
    bridgeSchemaVersion: null,
    projectionVersion: null,
    operationProtocolVersion: null,
    capabilities: [],
    reason,
  });
}

export function negotiateGlobalProtocol(serverValue, clientValue) {
  if (serverValue === null || serverValue === undefined) {
    return limitedGlobalProtocol(GLOBAL_PROTOCOL_COMPATIBILITY.newTuiOldServer, "global-server-offer-unavailable");
  }
  if (clientValue === null || clientValue === undefined) {
    return limitedGlobalProtocol(GLOBAL_PROTOCOL_COMPATIBILITY.oldTuiNewServer, "global-client-offer-unavailable");
  }
  const server = makeGlobalPeerOffer(serverValue);
  const client = makeGlobalPeerOffer(clientValue);
  const bridgeSchemaVersion = [...server.bridgeSchemaVersions].reverse().find((version) => client.bridgeSchemaVersions.includes(version)) ?? null;
  const projectionVersion = [...server.projectionVersions].reverse().find((version) => client.projectionVersions.includes(version)) ?? null;
  const operationProtocolVersion = [...server.operationProtocolVersions].reverse().find((version) => client.operationProtocolVersions.includes(version)) ?? null;
  const capabilities = GLOBAL_CAPABILITIES.filter((capability) => server.capabilities.includes(capability) && client.capabilities.includes(capability));
  if (bridgeSchemaVersion === null || projectionVersion === null || operationProtocolVersion === null
      || !GLOBAL_AUTHORITATIVE_CAPABILITIES.every((capability) => capabilities.includes(capability))) {
    return limitedGlobalProtocol("limited-incompatible-global-protocol", "global-authority-capability-unavailable");
  }
  return deepFreeze({
    mode: "native",
    label: GLOBAL_PROTOCOL_COMPATIBILITY.native,
    bridgeSchemaVersion,
    projectionVersion,
    operationProtocolVersion,
    capabilities,
    reason: null,
  });
}

export function makeUiProtocolOffer(value) {
  exactKeys(value, UI_PROTOCOL_OFFER_FIELDS, "ui-protocol-offer");
  const projectionVersions = exactSortedList(value.projectionVersions, "projection-versions", [UI_PROJECTION_VERSION], 4, "unsupported-projection-version");
  const operationProtocolVersions = exactSortedList(value.operationProtocolVersions, "operation-versions", [1, UI_OPERATION_PROTOCOL_VERSION], 4, "unsupported-operation-version");
  const capabilities = exactSortedList(value.capabilities, "capabilities", ALL_UI_CAPABILITIES, 32, "unknown-capability");
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
  if (operationProtocolVersion === null) {
    capabilities = capabilities.filter((capability) => capability !== "automatic-recommendations-control-v1"
      && !capability.startsWith("operation-"));
  }
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
    supportedCapabilities: exactSortedList(value.supportedCapabilities, "capabilities", ALL_UI_CAPABILITIES, UI_PROTOCOL_LIMITS.capabilities, "unknown-capability"),
  };
}

function makeStatus(value) {
  const legacyFields = [
    "state", "reason", "storedMode", "effectiveMode", "paused", "killSwitchActive",
    "repoExcluded", "circuitBreakerOpen",
  ];
  const legacy = Object.hasOwn(value ?? {}, "storedMode");
  exactKeys(value, legacy ? legacyFields : INDEX_STATUS_FIELDS, "ui-projection-status");
  if (legacy) {
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
  return {
    state: asEnum(value.state, ["ready", "setup-required", "startup-pending", "unavailable", "corrupt", "terminal"], "projection-status"),
    reason: asNullableReason(value.reason),
    automaticRecommendationsEnabled: asBoolean(
      value.automaticRecommendationsEnabled,
      "automatic-recommendations-enabled",
    ),
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

function makeDashboardReason(value, label = "dashboard-reason", dashboardVersion = UI_DASHBOARD_VERSION) {
  const reasonCodes = dashboardVersion === 3
    ? UI_DASHBOARD_REASON_CODES
    : [...UI_DASHBOARD_REASON_CODES, "paused"];
  return value === null ? null : asEnum(value, reasonCodes, label);
}

function makeDashboardGlobalRootPolicy(value) {
  if (value === null) return null;
  exactKeys(value, ["roots", "creationRootPath", "rootSetHash", "updatedAt"], "dashboard-global-root-policy");
  if (!Array.isArray(value.roots) || value.roots.length < 1 || value.roots.length > 32) {
    fail("dashboard-global-root-policy-roots-out-of-bounds");
  }
  const roots = value.roots.map((root) => {
    exactKeys(root, ROOT_POLICY_ROOT_FIELDS, "dashboard-global-root-policy-root");
    const clean = makeApprovedGlobalRoot(root);
    return {
      canonicalPath: clean.canonicalPath,
      canUpdate: clean.canUpdate,
      canCreate: clean.canCreate,
    };
  });
  const creationRootPath = value.creationRootPath === null
    ? null
    : makeApprovedGlobalRoot({
        canonicalPath: value.creationRootPath,
        canUpdate: true,
        canCreate: false,
      }).canonicalPath;
  return {
    roots,
    creationRootPath,
    rootSetHash: asHash(value.rootSetHash, "root-set-hash"),
    updatedAt: asTimestamp(value.updatedAt, "root-policy-updated-at"),
  };
}

function makeDashboardCollectionSuggestions(value) {
  if (!Array.isArray(value) || value.length > 32) {
    fail("dashboard-collection-suggestions-out-of-bounds");
  }
  const suggestions = value.map((canonicalPath) => makeApprovedGlobalRoot({
    canonicalPath,
    canUpdate: true,
    canCreate: false,
  }).canonicalPath);
  if (new Set(suggestions).size !== suggestions.length) fail("dashboard-collection-suggestions-duplicate");
  for (let index = 1; index < suggestions.length; index += 1) {
    if (compareText(suggestions[index - 1], suggestions[index]) >= 0) {
      fail("dashboard-collection-suggestions-not-sorted");
    }
  }
  return suggestions;
}

function makeDashboardBudgetUsage(value, label) {
  exactKeys(value, DASHBOARD_BUDGET_USAGE_FIELDS, `${label}-usage`);
  const used = asInt(value.used, `${label}-used`, { max: 1_000_000_000 });
  const limit = asInt(value.limit, `${label}-limit`, { max: 1_000_000_000 });
  const remaining = asInt(value.remaining, `${label}-remaining`, { max: 1_000_000_000 });
  if (remaining !== Math.max(0, limit - used)) fail(`${label}-remaining-mismatch`);
  return { used, limit, remaining, resetAt: asNullableTimestamp(value.resetAt, `${label}-reset-at`) };
}

function makeDashboardUsage(value, dashboardVersion) {
  const fields = dashboardVersion === 3 ? DASHBOARD_USAGE_V3_FIELDS : DASHBOARD_USAGE_FIELDS;
  exactKeys(value, fields, "dashboard-usage");
  exactKeys(value.storage, DASHBOARD_STORAGE_USAGE_FIELDS, "dashboard-storage-usage");
  const usedBytes = asInt(value.storage.usedBytes, "storage-used-bytes");
  const limitBytes = asInt(value.storage.limitBytes, "storage-limit-bytes");
  const remainingBytes = asInt(value.storage.remainingBytes, "storage-remaining-bytes");
  if (remainingBytes !== Math.max(0, limitBytes - usedBytes)) fail("storage-remaining-mismatch");
  const providerField = dashboardVersion === 3 ? "provider" : "passive";
  return {
    [providerField]: makeDashboardBudgetUsage(value[providerField], providerField),
    synthesis: makeDashboardBudgetUsage(value.synthesis, "synthesis"),
    storage: { usedBytes, limitBytes, remainingBytes },
  };
}

function makeDashboardLastCycle(value, dashboardVersion) {
  if (value === null) return null;
  exactKeys(
    value,
    dashboardVersion === 3 ? DASHBOARD_LAST_CYCLE_V3_FIELDS : DASHBOARD_LAST_CYCLE_FIELDS,
    "dashboard-last-cycle",
  );
  const common = {
    outcome: asEnum(value.outcome, UI_CYCLE_OUTCOMES, "cycle-outcome"),
    triggerClass: asEnum(value.triggerClass, ["manual", "idle", "recovery", "other"], "cycle-trigger-class"),
  };
  const tail = {
    observationCount: asInt(value.observationCount, "cycle-observation-count", { max: 1_000_000 }),
    eligibilityCount: asInt(value.eligibilityCount, "cycle-eligibility-count", { max: 1_000_000 }),
    proposalId: value.proposalId === null ? null : asId(value.proposalId, "cycle-proposal-id"),
    occurredAt: asTimestamp(value.occurredAt, "cycle-occurred-at"),
    reason: makeDashboardReason(value.reason, "cycle-reason", dashboardVersion),
  };
  return dashboardVersion === 3
    ? { ...common, ...tail }
    : { ...common, mode: asEnum(value.mode, MODES, "cycle-mode"), ...tail };
}

function makeDashboardActivity(value, dashboardVersion) {
  exactKeys(value, DASHBOARD_ACTIVITY_FIELDS, "dashboard-activity-entry");
  return {
    id: asHash(value.id, "activity-id"),
    category: asEnum(value.category, ["cycle", "recommendation", "system", "error"], "activity-category"),
    audience: asEnum(value.audience, ["default", "diagnostic"], "activity-audience"),
    outcome: asEnum(
      value.outcome,
      dashboardVersion === 3 ? UI_DASHBOARD_OUTCOMES : [...UI_DASHBOARD_OUTCOMES, "paused", "resumed"],
      "activity-outcome",
    ),
    summary: asText(value.summary, "activity-summary", UI_PROTOCOL_LIMITS.dashboardSummaryBytes),
    occurredAt: asTimestamp(value.occurredAt, "activity-occurred-at"),
    proposalId: value.proposalId === null ? null : asId(value.proposalId, "activity-proposal-id"),
    reason: makeDashboardReason(value.reason, "activity-reason", dashboardVersion),
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
  const dashboardCapabilities = dashboardVersion === 3
    ? UI_DASHBOARD_CAPABILITIES
    : LEGACY_UI_DASHBOARD_CAPABILITIES;
  const capabilities = exactSortedList(
    value.capabilities,
    "dashboard-capabilities",
    dashboardCapabilities,
    dashboardCapabilities.length,
    "unknown-dashboard-capability",
  );
  exactKeys(value.automation, DASHBOARD_AUTOMATION_FIELDS, "dashboard-automation");
  const automation = {
    state: asEnum(
      value.automation.state,
      dashboardVersion === 3 ? UI_DASHBOARD_AUTOMATION_STATES : LEGACY_DASHBOARD_AUTOMATION_STATES,
      "dashboard-automation-state",
    ),
    reason: makeDashboardReason(value.automation.reason, "dashboard-automation-reason", dashboardVersion),
  };
  const blockerDestinations = dashboardVersion === 3
    ? UI_DASHBOARD_BLOCKER_DESTINATIONS
    : LEGACY_DASHBOARD_BLOCKER_DESTINATIONS;
  const blockerCodes = Object.keys(blockerDestinations);
  if (!Array.isArray(value.blockers) || value.blockers.length > blockerCodes.length) fail("dashboard-blockers-out-of-bounds");
  const blockers = value.blockers.map((blocker) => {
    exactKeys(blocker, DASHBOARD_BLOCKER_FIELDS, "dashboard-blocker");
    const output = {
      code: asEnum(blocker.code, blockerCodes, "dashboard-blocker-code"),
      summary: asText(blocker.summary, "dashboard-blocker-summary", UI_PROTOCOL_LIMITS.dashboardSummaryBytes),
      destination: asEnum(blocker.destination, ["home", "recommendations", "activity-errors", "settings"], "dashboard-destination"),
    };
    if (blockerDestinations[output.code].dashboard !== output.destination) {
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
  const lastCycle = makeDashboardLastCycle(value.lastCycle, dashboardVersion);
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
  exactKeys(
    value.settings,
    dashboardVersion === 1
      ? DASHBOARD_SETTINGS_FIELDS
      : dashboardVersion === 2
        ? DASHBOARD_SETTINGS_V2_FIELDS
        : DASHBOARD_SETTINGS_V3_FIELDS,
    "dashboard-settings",
  );
  const consentFields = dashboardVersion === 3 ? DASHBOARD_CONSENT_V3_FIELDS : DASHBOARD_CONSENT_FIELDS;
  exactKeys(value.settings.consent, consentFields, "dashboard-consent");
  const settings = dashboardVersion === 3
    ? {
        automaticRecommendationsEnabled: asBoolean(
          value.settings.automaticRecommendationsEnabled,
          "dashboard-automatic-recommendations-enabled",
        ),
        automationGeneration: asInt(
          value.settings.automationGeneration,
          "dashboard-automation-generation",
          { min: 1 },
        ),
        killSwitchActive: asBoolean(value.settings.killSwitchActive, "dashboard-kill-switch"),
        repositoryExcluded: asBoolean(value.settings.repositoryExcluded, "dashboard-repository-excluded"),
        consent: Object.fromEntries(consentFields.map((field) => [
          field, asBoolean(value.settings.consent[field], `dashboard-consent-${field}`),
        ])),
        approvedSkillFolderCount: asInt(value.settings.approvedSkillFolderCount, "dashboard-approved-skill-folder-count", { max: 1_000_000 }),
        collectionSuggestions: makeDashboardCollectionSuggestions(value.settings.collectionSuggestions),
      }
    : {
        globalMode: asEnum(value.settings.globalMode, MODES, "dashboard-global-mode"),
        repositoryMode: asEnum(value.settings.repositoryMode, ["inherit", ...MODES], "dashboard-repository-mode"),
        effectiveMode: asEnum(value.settings.effectiveMode, MODES, "dashboard-effective-mode"),
        paused: asBoolean(value.settings.paused, "dashboard-paused"),
        killSwitchActive: asBoolean(value.settings.killSwitchActive, "dashboard-kill-switch"),
        repositoryExcluded: asBoolean(value.settings.repositoryExcluded, "dashboard-repository-excluded"),
        consent: Object.fromEntries(consentFields.map((field) => [
          field, asBoolean(value.settings.consent[field], `dashboard-consent-${field}`),
        ])),
        approvedSkillFolderCount: asInt(value.settings.approvedSkillFolderCount, "dashboard-approved-skill-folder-count", { max: 1_000_000 }),
      };
  if (dashboardVersion >= 2) {
    settings.globalSettingsVersion = asHash(value.settings.globalSettingsVersion, "global-settings-version");
    settings.globalRootPolicy = makeDashboardGlobalRootPolicy(value.settings.globalRootPolicy);
    settings.globalRootPolicyConfirmation = asText(
      value.settings.globalRootPolicyConfirmation,
      "global-root-policy-confirmation",
      64,
      { singleLine: true },
    );
    settings.globalRootPolicyAction = value.settings.globalRootPolicyAction === null
      ? null
      : makeAllowedAction(value.settings.globalRootPolicyAction, {
          capabilities,
          expiresAt: generatedAt + UI_PROTOCOL_LIMITS.projectionTtlMs,
          now: expected.now,
        });
    if (settings.globalRootPolicyAction !== null
        && settings.globalRootPolicyAction.action !== "replace-global-root-policy") {
      fail("invalid-global-root-policy-action");
    }
  }
  if (dashboardVersion === 3) {
    const permissionsReady = Object.values(settings.consent).every((allowed) => allowed === true);
    if (settings.automaticRecommendationsEnabled && !permissionsReady) {
      fail("dashboard-automatic-permissions-inconsistent");
    }
    if (settings.automaticRecommendationsEnabled && automation.state === "off") {
      fail("dashboard-automatic-state-inconsistent");
    }
    if (!settings.automaticRecommendationsEnabled
        && !["terminal", "corrupt", "emergency-stop", "circuit-breaker", "excluded", "off"].includes(automation.state)) {
      fail("dashboard-automatic-state-inconsistent");
    }
  }
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
  if (dashboardVersion >= 2 && retention.operationalDays !== retention.observationsDays * 3) {
    fail("dashboard-retention-mismatch");
  }
  const supportedControls = exactSortedList(
    value.supportedControls,
    "dashboard-supported-controls",
    dashboardVersion === 3 ? UI_ACTIONS : ALL_UI_ACTIONS,
    dashboardVersion === 3 ? UI_ACTIONS.length : ALL_UI_ACTIONS.length,
    "unknown-dashboard-control",
  );
  for (const action of supportedControls) {
    const capability = ALL_UI_ACTION_CAPABILITIES[action];
    if (!ALL_UI_CAPABILITIES.includes(capability) && !capabilities.includes(capability)) {
      fail("unsupported-dashboard-control", action);
    }
  }
  if (!Array.isArray(value.activity) || value.activity.length > UI_PROTOCOL_LIMITS.activityEntries) fail("dashboard-activity-out-of-bounds");
  const activity = value.activity.map((entry) => makeDashboardActivity(entry, dashboardVersion));
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
    usage: makeDashboardUsage(value.usage, dashboardVersion),
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
    action: asEnum(value.action, ALL_UI_ACTIONS, "ui-action"),
    status: asEnum(value.status, ["queued", "running", "completed", "failed", "accepted-terminal"], "operation-status"),
    updatedAt: asTimestamp(value.updatedAt, "operation-updated-at"),
    reason: asNullableReason(value.reason),
  };
}

function makeAllowedAction(value, { capabilities, expiresAt, now }) {
  exactKeys(value, ALLOWED_ACTION_FIELDS, "ui-allowed-action");
  const action = asEnum(value.action, ALL_UI_ACTIONS, "ui-action");
  const capability = asEnum(value.capability, [...new Set([
    ...UI_OPERATION_CAPABILITIES,
    ...LEGACY_UI_CAPABILITIES,
    ...LEGACY_UI_DASHBOARD_CAPABILITIES,
  ])], "capability");
  if (ALL_UI_ACTION_CAPABILITIES[action] !== capability) fail("action-capability-mismatch");
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
  const capabilities = exactSortedList(value.capabilities, "capabilities", ALL_UI_CAPABILITIES, UI_PROTOCOL_LIMITS.capabilities, "unknown-capability");
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
    supportedCapabilities: exactSortedList(value.supportedCapabilities, "capabilities", ALL_UI_CAPABILITIES, UI_PROTOCOL_LIMITS.capabilities, "unknown-capability"),
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
  const supportedCapabilities = exactSortedList(value.supportedCapabilities, "capabilities", UI_OPERATION_CAPABILITIES, UI_PROTOCOL_LIMITS.capabilities, "unknown-capability");
  exactKeys(value.grant, ALLOWED_ACTION_FIELDS, "ui-operation-grant");
  if (!UI_OPERATION_ACTIONS.includes(value.grant.action)) fail("invalid-operation-grant-action");
  const grant = {
    action: value.grant.action,
    capability: asEnum(value.grant.capability, UI_OPERATION_CAPABILITIES, "operation-grant-capability"),
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

export function globalRootPolicyConfirmation(settingsVersion) {
  return `REPLACE GLOBAL ROOT POLICY ${asHash(settingsVersion, "settings-version").slice(0, 12)}`;
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
  if (action === "set-automatic-recommendations") {
    exactKeys(value, SETTINGS_PAYLOAD_FIELDS, "automatic-recommendations-payload");
    return {
      enabled: asBoolean(value.enabled, "automatic-recommendations-enabled"),
      settingsVersion: asHash(value.settingsVersion, "settings-version"),
    };
  }
  if (action === "set-permission") {
    exactKeys(value, PERMISSION_PAYLOAD_FIELDS, "permission-payload");
    return {
      permission: asEnum(
        value.permission,
        ["durableObservations", "sanitizedExcerpts", "crossRepoAggregation"],
        "data-permission",
      ),
      enabled: asBoolean(value.enabled, "data-permission-enabled"),
      settingsVersion: asHash(value.settingsVersion, "settings-version"),
    };
  }
  if (action === "set-repo-excluded") {
    exactKeys(value, PROJECT_EXCLUSION_PAYLOAD_FIELDS, "project-exclusion-payload");
    return {
      excluded: asBoolean(value.excluded, "project-excluded"),
      settingsVersion: asHash(value.settingsVersion, "settings-version"),
    };
  }
  if (action === "replace-global-root-policy") {
    exactKeys(value, ROOT_POLICY_PAYLOAD_FIELDS, "global-root-policy-payload");
    const settingsVersion = asHash(value.settingsVersion, "settings-version");
    if (!Array.isArray(value.roots) || value.roots.length < 1 || value.roots.length > 32) {
      fail("global-root-policy-roots-out-of-bounds");
    }
    const roots = value.roots.map((root) => {
      exactKeys(root, ROOT_POLICY_ROOT_FIELDS, "global-root-policy-root");
      const clean = makeApprovedGlobalRoot(root);
      return {
        canonicalPath: clean.canonicalPath,
        canUpdate: clean.canUpdate,
        canCreate: clean.canCreate,
      };
    });
    if (new Set(roots.map((root) => root.canonicalPath)).size !== roots.length) {
      fail("duplicate-global-root-path");
    }
    for (let index = 1; index < roots.length; index += 1) {
      if (compareText(roots[index - 1].canonicalPath, roots[index].canonicalPath) >= 0) {
        fail("global-root-policy-roots-not-sorted");
      }
    }
    const creationRootPath = value.creationRootPath === null
      ? null
      : makeApprovedGlobalRoot({
          canonicalPath: value.creationRootPath,
          canUpdate: true,
          canCreate: false,
        }).canonicalPath;
    const createRoots = roots.filter((root) => root.canCreate);
    if ((creationRootPath === null && createRoots.length !== 0)
        || (creationRootPath !== null
          && (createRoots.length !== 1 || createRoots[0].canonicalPath !== creationRootPath))) {
      fail("global-root-policy-creation-root-mismatch");
    }
    const confirmation = asText(value.confirmation, "global-root-policy-confirmation", 64, { singleLine: true });
    if (confirmation !== globalRootPolicyConfirmation(settingsVersion)) {
      fail("invalid-global-root-policy-confirmation");
    }
    return { roots, creationRootPath, confirmation, settingsVersion };
  }
  if (action === "purge-scope") {
    exactKeys(value, PURGE_SCOPE_PAYLOAD_FIELDS, "purge-scope-payload");
    const scope = asEnum(value.scope, ["observations", "global-recommendations", "project"], "purge-scope");
    const confirmation = asText(value.confirmation, "purge-confirmation", 64, { singleLine: true });
    if (confirmation !== `PURGE ${scope.toUpperCase()}`) fail("invalid-purge-confirmation");
    return { scope, confirmation };
  }
  if (action === "purge-all") {
    exactKeys(value, CONFIRMATION_PAYLOAD_FIELDS, "purge-all-payload");
    const confirmation = asText(value.confirmation, "purge-all-confirmation", 64, { singleLine: true });
    if (confirmation !== "PURGE ALL SELF-EVOLVE 0.4.0") fail("invalid-purge-confirmation");
    return { confirmation };
  }
  if (action === "export-data") {
    exactKeys(value, EXPORT_PAYLOAD_FIELDS, "export-payload");
    const scope = asEnum(value.scope, ["observations", "global-recommendations", "project", "all"], "export-scope");
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
  const capability = asEnum(value.capability, UI_OPERATION_CAPABILITIES, "capability");
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
