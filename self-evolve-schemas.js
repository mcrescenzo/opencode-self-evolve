import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "0.2.2";
// Earlier schema versions whose persisted records and settings the current validators still read.
// Values are normalized to SCHEMA_VERSION on read, so durable state written by a previous release
// is migrated in place instead of being quarantined as damaged. Record identity is content-addressed
// over kind+payload only, so re-stamping the version never changes an id; assertRecord still rejects
// any record whose payload fails to round-trip. Only list a version here once its records are known
// to re-wrap to an identical id under the current validators.
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(["0.2.0", "0.2.1", SCHEMA_VERSION]);
export const UNKNOWN_SESSION_LINEAGE_HASH = createHash("sha256").update("self-evolve-session-lineage-v1\nunknown").digest("hex");
export const UNKNOWN_ROOT_LINEAGE_HASH = createHash("sha256").update("self-evolve-root-lineage-v1\nunknown").digest("hex");

const MAX = Object.freeze({
  string: 1024,
  path: 1024,
  actor: 128,
  reason: 512,
  rationale: 2048,
  model: 256,
  list: 128,
  roots: 32,
  receiptIds: 64,
  incidents: 256,
  reasons: 32,
  detailsKeys: 32,
  structuredKeys: 16,
  burnedNonces: 128,
});

const MODES = Object.freeze(["manual", "auto", "yolo"]);
const REPO_MODES = Object.freeze([...MODES, "inherit"]);
const RECEIPT_TYPES = Object.freeze([
  "repeated-command",
  "repeated-tool-error",
  "repeated-manual-procedure",
  "repeated-clarification",
]);
const AGGREGATE_CLAIM_TYPES = Object.freeze(["global-skill-candidate"]);
export const ORIGIN_KINDS = Object.freeze(["user", "delegated", "hidden", "plugin-created", "anonymous", "unknown"]);
const PROPOSAL_STATES = Object.freeze([
  "critic-pending",
  "pending",
  "approved",
  "rejected",
  "applied",
  "rolled-back",
  "superseded",
  "failed-closed",
]);
const AUDIT_KINDS = Object.freeze([
  "apply",
  "rollback",
  "decision",
  "mode-change",
  "kill-switch",
  "purge",
  "lease",
  "corruption",
]);
export const SYNTHESIS_OUTCOME_STATUSES = Object.freeze(["accepted", "no-change", "critic-rejected", "failed"]);
const SYNTHESIS_OUTCOME_REASON_CODES = Object.freeze({
  accepted: Object.freeze(["accepted"]),
  "no-change": Object.freeze(["valid-no-change"]),
  "critic-rejected": Object.freeze(["critic-rejected"]),
  failed: Object.freeze(["malformed-output", "timeout", "deterministic-validation-failed", "proposal-content-unavailable", "proposal-content-persistence-failed", "synthesis-failed", "critic-failed", "unknown-failure"]),
});
const RECORD_KINDS = Object.freeze([
  "global-settings",
  "repo-settings",
  "episode-cursor",
  "receipt",
  "observation",
  "evidence-cluster",
  "eligibility-explanation",
  "proposal",
  "proposal-content",
  "synthesis-attempt",
  "decision",
  "apply-claim",
  "audit-event",
  "rollback-record",
  "intervention-epoch",
  "circuit-breaker",
]);

export const DEFAULT_BUDGETS = Object.freeze({
  passiveCallsPerHour: 6,
  synthesisPerDay: 24,
  tokensPerSynthesis: 8000,
  concurrentObservationsPerProject: 1,
  concurrentSynthesesGlobal: 1,
  idleDebounceMs: 1500,
  storageQuotaMiB: 8,
  notificationsPerHour: 3,
});

function fail(code, detail = "") {
  throw new TypeError(detail ? `${code}: ${detail}` : code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value, label) {
  if (!isObject(value)) fail("malformed-payload", `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label, required = allowed) {
  object(value, label);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) fail("malformed-payload", `${label} has unexpected field ${extras[0]}`);
  const missing = required.filter((key) => !(key in value));
  if (missing.length) fail("malformed-payload", `${label} is missing ${missing[0]}`);
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function errorReasonCode(error, fallback = "error") {
  const message = error instanceof Error ? error.message : String(error ?? fallback);
  return message.split(":", 1)[0] || fallback;
}

export function latestByLogicalId(records, { withPayload = false } = {}) {
  const latest = new Map();
  for (const record of records ?? []) {
    const id = record?.payload?.id ?? record?.payload?.proposalId ?? record?.id;
    latest.set(id, withPayload ? record?.payload ?? record : record);
  }
  return latest;
}

export function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

export function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("malformed-payload", "non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  fail("malformed-payload", "value is not canonical JSON");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedList(value, label, max, itemValidator, { dedupe = false, defaultValue } = {}) {
  const input = value === undefined && defaultValue !== undefined ? defaultValue : value;
  if (!Array.isArray(input)) fail("malformed-payload", `${label} must be an array`);
  if (input.length > max) fail("out-of-bounds", `${label} exceeds ${max} items`);
  const cleaned = input.map((item, index) => itemValidator(item, index));
  return dedupe ? [...new Set(cleaned)] : cleaned;
}

function asBoolean(value, label, defaultValue) {
  const input = value === undefined ? defaultValue : value;
  if (typeof input !== "boolean") fail("malformed-payload", `${label} must be boolean`);
  return input;
}

function schemaVersion(value) {
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(value)) fail("unsupported-version", String(value ?? "missing"));
  return SCHEMA_VERSION;
}

function compareSchemaVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((part) => !Number.isInteger(part) || part < 0)) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

/**
 * Structural version adapter only. Callers must validate the returned document
 * with makeGlobalSettings/makeRepoSettings after selecting its partition shape.
 * Legacy combined files can carry store-owned fields or receive their repository
 * identity from the partition path, so this function cannot validate them alone.
 */
export function migrateSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const comparison = compareSchemaVersions(settings.schemaVersion, SCHEMA_VERSION);
  if (comparison === null || comparison > 0) return null;
  if (comparison === 0) return settings;
  const migrateRepo = (repo) => {
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) return repo;
    const { consent: _removedConsent, ...rest } = repo;
    return { ...rest, schemaVersion: SCHEMA_VERSION };
  };
  if ("projectFingerprint" in settings && !("global" in settings) && !("repo" in settings)) {
    return migrateRepo(settings);
  }
  return {
    ...settings,
    schemaVersion: SCHEMA_VERSION,
    ...(settings.global ? { global: { ...settings.global, schemaVersion: SCHEMA_VERSION } } : {}),
    ...(settings.repo ? { repo: migrateRepo(settings.repo) } : {}),
  };
}

export function asString(value, { max = MAX.string } = {}) {
  if (typeof value !== "string") fail("malformed-string");
  if (!Number.isInteger(max) || max < 0) fail("invalid-bound", "max");
  const cleaned = value.trim();
  if (cleaned.length > max) fail("out-of-bounds", `string exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(cleaned)) fail("control-character");
  return cleaned;
}

export function asNonEmptyString(value, { max = MAX.string } = {}) {
  const cleaned = asString(value, { max });
  if (!cleaned) fail("empty-string");
  return cleaned;
}

export function asEnum(value, allowed) {
  if (!Array.isArray(allowed) || !allowed.length) fail("invalid-enum");
  if (!allowed.includes(value)) fail("invalid-enum", String(value));
  return value;
}

export function asInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("out-of-bounds", `integer must be ${min}..${max}`);
  return value;
}

export function asTimestamp(value) {
  return asInt(value, { min: 0, max: 8_640_000_000_000_000 });
}

export function asSha256Hex(value) {
  const cleaned = asNonEmptyString(value, { max: 64 }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleaned)) fail("invalid-sha256");
  return cleaned;
}

export function asFingerprint(value) {
  return asSha256Hex(value);
}

export function asMode(value) {
  return asEnum(value, MODES);
}

export function asPath(value) {
  const cleaned = asNonEmptyString(value, { max: MAX.path }).replace(/\\/g, "/");
  if (/[*?\[\]{}]/.test(cleaned)) fail("glob-path");
  if (cleaned.split("/").includes("..")) fail("path-escape");
  if (cleaned.split("/").includes(".")) fail("ambiguous-path");
  return cleaned.length > 1 ? cleaned.replace(/\/+$/, "") : cleaned;
}

function absolutePath(value) {
  const cleaned = asPath(value);
  if (!cleaned.startsWith("/") && !/^[A-Za-z]:\//.test(cleaned)) fail("non-canonical-root");
  return cleaned;
}

function idString(value, label = "id") {
  return asNonEmptyString(value, { max: 128 });
}

function nonceString(value) {
  return asNonEmptyString(value, { max: 128 });
}

function finiteNumber(value, { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) fail("out-of-bounds", `number must be ${min}..${max}`);
  return value;
}

function byteBoundedString(value, maxBytes) {
  const cleaned = asNonEmptyString(value, { max: maxBytes });
  if (Buffer.byteLength(cleaned, "utf8") > maxBytes) fail("out-of-bounds", `string exceeds ${maxBytes} bytes`);
  return cleaned;
}

function primitiveMap(value, label, maxKeys = MAX.detailsKeys) {
  object(value, label);
  const keys = Object.keys(value);
  if (keys.length > maxKeys) fail("out-of-bounds", `${label} has too many fields`);
  const output = {};
  for (const key of keys.sort()) {
    const cleanKey = asNonEmptyString(key, { max: 64 });
    const item = value[key];
    if (typeof item === "string") output[cleanKey] = asString(item, { max: 512 });
    else if (typeof item === "boolean") output[cleanKey] = item;
    else if (Number.isSafeInteger(item)) output[cleanKey] = asInt(item, { min: 0 });
    else if (item === null) output[cleanKey] = null;
    else fail("malformed-payload", `${label}.${key} must be a bounded primitive`);
  }
  return output;
}

export const Mode = deepFreeze({ values: MODES, default: "manual" });
export const ConsentState = deepFreeze({
  fields: ["passiveCalls", "durableObservations", "sanitizedExcerpts", "crossRepoAggregation"],
  defaults: { passiveCalls: false, durableObservations: false, sanitizedExcerpts: false, crossRepoAggregation: false },
});
export const Budgets = deepFreeze({ fields: Object.keys(DEFAULT_BUDGETS), defaults: DEFAULT_BUDGETS });
export const GlobalSettings = deepFreeze({
  fields: ["schemaVersion", "mode", "createdAt", "updatedAt", "paused", "killSwitchActive", "allowedSkillRoots", "consent", "budgets", "retentionDays"],
});
export const RepoSettings = deepFreeze({
  fields: ["schemaVersion", "projectFingerprint", "mode", "excluded", "budgets"],
});
export const EpisodeCursor = deepFreeze({ fields: ["sessionIDHash", "lastIdleAt", "lastObservedMessageHash", "leaseNonce"] });
export const Receipt = deepFreeze({ fields: ["receiptType", "signatureHash", "occurrences", "firstSeenAt", "lastSeenAt", "projectFingerprint", "scopeFingerprint", "targetLogicalName"] });
export const Observation = deepFreeze({ fields: ["id", "projectFingerprint", "receiptIds", "structuredFields", "incidentId", "sessionLineageHash", "rootLineageHash", "originKind", "createdAt", "injectionFlagged", "redacted"] });
export const EvidenceCluster = deepFreeze({ fields: ["id", "receiptType", "projectFingerprint", "incidentIds", "scopeFingerprint", "targetLogicalName", "occurrencesSum", "firstSeenAt", "lastSeenAt"] });
export const EligibilityExplanation = deepFreeze({ fields: ["clusterId", "eligible", "reasons", "thresholdsMet", "thresholdsMissed"] });
export const Proposal = deepFreeze({
  fields: ["id", "projectFingerprint", "clusterId", "skillTarget", "proposedContentHash", "rationaleText", "synthesizedAt", "synthesizerModelId", "criticScore", "criticPassed", "validDeterministic", "state", "injectionFlagged", "decisionVersion", "burnedNonceHashes"],
});
export const ProposalContent = deepFreeze({ fields: ["proposalId", "contentHash", "contentEncoding", "chunkIndex", "chunkCount", "content"] });
export const SynthesisAttempt = deepFreeze({ fields: ["outcomeId", "proposalId", "projectFingerprint", "clusterId", "targetHash", "admittedAt", "state"] });
export const Decision = deepFreeze({ fields: ["proposalId", "targetHash", "proposedContentHash", "decisionVersion", "actor", "timestamp", "nonce", "priorState", "newState"] });
// Retained for durable-record compatibility and pure transition validation. The
// production applier deliberately uses the store's process-aware filesystem
// lease instead of this reducer; removing the schema would make compatible
// historical `apply-claim` records unreadable.
export const ApplyClaim = deepFreeze({ fields: ["proposalId", "leaseNonce", "acquiredAt", "expiresAt", "actor"] });
export const AuditEvent = deepFreeze({ fields: ["id", "kind", "proposalId", "actor", "timestamp", "payloadHash", "details"] });
export const RollbackRecord = deepFreeze({ fields: ["proposalId", "appliedHash", "rolledBackAt", "reason"] });
export const InterventionEpoch = deepFreeze({ fields: ["epochId", "startedAt", "reason"] });
export const CircuitBreaker = deepFreeze({ fields: ["open", "openedAt", "reason", "tripCount"] });
export const AggregateClaim = deepFreeze({
  fields: ["schemaVersion", "aggregateId", "claimType", "receiptType", "signatureHash", "incidentHash", "occurrenceCount", "firstSeenDay", "lastSeenDay", "createdAt", "expiresAt"],
});

export function makeConsentState(data = {}) {
  exactKeys(data, ConsentState.fields, "ConsentState", []);
  return deepFreeze({
    passiveCalls: asBoolean(data.passiveCalls, "passiveCalls", false),
    durableObservations: asBoolean(data.durableObservations, "durableObservations", false),
    sanitizedExcerpts: asBoolean(data.sanitizedExcerpts, "sanitizedExcerpts", false),
    crossRepoAggregation: asBoolean(data.crossRepoAggregation, "crossRepoAggregation", false),
  });
}

function validateBudgets(data = {}, partial = false) {
  exactKeys(data, Budgets.fields, "Budgets", []);
  const result = {};
  for (const key of Budgets.fields) {
    if (partial && !(key in data)) continue;
    result[key] = asInt(data[key] ?? DEFAULT_BUDGETS[key], { min: 0, max: 1_000_000_000 });
  }
  return deepFreeze(result);
}

export function makeBudgets(data = {}) {
  return validateBudgets(data, false);
}

export function makeGlobalSettings(data = {}) {
  exactKeys(data, GlobalSettings.fields, "GlobalSettings", []);
  const createdAt = asTimestamp(data.createdAt ?? 0);
  const updatedAt = asTimestamp(data.updatedAt ?? createdAt);
  if (updatedAt < createdAt) fail("out-of-order", "updatedAt precedes createdAt");
  const roots = boundedList(data.allowedSkillRoots, "allowedSkillRoots", MAX.roots, absolutePath, { dedupe: true, defaultValue: [] });
  return deepFreeze({
    schemaVersion: schemaVersion(data.schemaVersion ?? SCHEMA_VERSION),
    mode: asMode(data.mode ?? "manual"),
    createdAt,
    updatedAt,
    paused: asBoolean(data.paused, "paused", false),
    killSwitchActive: asBoolean(data.killSwitchActive, "killSwitchActive", false),
    allowedSkillRoots: roots,
    consent: makeConsentState(data.consent ?? {}),
    budgets: makeBudgets(data.budgets ?? {}),
    retentionDays: asInt(data.retentionDays ?? 30, { min: 1, max: 3650 }),
  });
}

export function makeRepoSettings(data) {
  exactKeys(data, RepoSettings.fields, "RepoSettings", ["projectFingerprint"]);
  return deepFreeze({
    schemaVersion: schemaVersion(data.schemaVersion ?? SCHEMA_VERSION),
    projectFingerprint: asFingerprint(data.projectFingerprint),
    mode: asEnum(data.mode ?? "inherit", REPO_MODES),
    excluded: asBoolean(data.excluded, "excluded", false),
    budgets: validateBudgets(data.budgets ?? {}, true),
  });
}

function utcDay(value, label) {
  const clean = asNonEmptyString(value, { max: 10 });
  const date = new Date(`${clean}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)
      || Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== clean) {
    fail("malformed-payload", `${label} must be a UTC day`);
  }
  return clean;
}

export function makeAggregateClaim(data) {
  exactKeys(data, AggregateClaim.fields, "AggregateClaim");
  const firstSeenDay = utcDay(data.firstSeenDay, "firstSeenDay");
  const lastSeenDay = utcDay(data.lastSeenDay, "lastSeenDay");
  const createdAt = asTimestamp(data.createdAt);
  const expiresAt = asTimestamp(data.expiresAt);
  if (lastSeenDay < firstSeenDay) fail("out-of-order", "lastSeenDay precedes firstSeenDay");
  if (expiresAt <= createdAt) fail("out-of-order", "aggregate must expire after creation");
  return deepFreeze({
    schemaVersion: schemaVersion(data.schemaVersion),
    aggregateId: asSha256Hex(data.aggregateId),
    claimType: asEnum(data.claimType, AGGREGATE_CLAIM_TYPES),
    receiptType: asEnum(data.receiptType, RECEIPT_TYPES),
    signatureHash: asSha256Hex(data.signatureHash),
    incidentHash: asSha256Hex(data.incidentHash),
    occurrenceCount: asInt(data.occurrenceCount, { min: 1, max: 1_000_000 }),
    firstSeenDay,
    lastSeenDay,
    createdAt,
    expiresAt,
  });
}

export function resolveMode(globalMode, repoMode = "inherit", overrides = {}) {
  try {
    exactKeys(overrides, ["killSwitchActive", "paused", "circuitBreakerOpen", "processExcluded", "repoOptOut", "hostSupported", "corrupt"], "mode overrides", []);
    const global = asMode(globalMode ?? "manual");
    const repo = asEnum(repoMode ?? "inherit", REPO_MODES);
    for (const key of ["killSwitchActive", "paused", "circuitBreakerOpen", "processExcluded", "repoOptOut", "corrupt"]) {
      if (overrides[key] !== undefined && typeof overrides[key] !== "boolean") return "manual";
    }
    if (overrides.hostSupported !== undefined && typeof overrides.hostSupported !== "boolean") return "manual";
    if (overrides.killSwitchActive || overrides.paused || overrides.circuitBreakerOpen || overrides.processExcluded || overrides.repoOptOut || overrides.corrupt || overrides.hostSupported === false) return "manual";
    return repo === "inherit" ? global : repo;
  } catch {
    return "manual";
  }
}

export function makeEpisodeCursor(data) {
  exactKeys(data, EpisodeCursor.fields, "EpisodeCursor", ["sessionIDHash"]);
  return deepFreeze({
    sessionIDHash: asSha256Hex(data.sessionIDHash),
    lastIdleAt: asTimestamp(data.lastIdleAt ?? 0),
    lastObservedMessageHash: data.lastObservedMessageHash === undefined || data.lastObservedMessageHash === null ? null : asSha256Hex(data.lastObservedMessageHash),
    leaseNonce: data.leaseNonce === undefined || data.leaseNonce === null ? null : nonceString(data.leaseNonce),
  });
}

export function canStartEpisode(cursor, now, debounceMs) {
  const current = makeEpisodeCursor(cursor);
  const timestamp = asTimestamp(now);
  const debounce = asInt(debounceMs, { min: 0, max: 86_400_000 });
  return !current.leaseNonce && timestamp >= current.lastIdleAt && (current.lastIdleAt === 0 || timestamp - current.lastIdleAt >= debounce);
}

export function beginEpisode(cursor, now, nonce) {
  const current = makeEpisodeCursor(cursor);
  const timestamp = asTimestamp(now);
  if (current.leaseNonce) fail("lease-conflict");
  if (timestamp < current.lastIdleAt) fail("out-of-order");
  return makeEpisodeCursor({ ...current, lastIdleAt: timestamp, leaseNonce: nonceString(nonce) });
}

export function makeReceipt(data) {
  exactKeys(data, Receipt.fields, "Receipt", Receipt.fields.filter((field) => field !== "targetLogicalName"));
  const firstSeenAt = asTimestamp(data.firstSeenAt);
  const lastSeenAt = asTimestamp(data.lastSeenAt);
  if (lastSeenAt < firstSeenAt) fail("out-of-order", "lastSeenAt precedes firstSeenAt");
  return deepFreeze({
    receiptType: asEnum(data.receiptType, RECEIPT_TYPES),
    signatureHash: asSha256Hex(data.signatureHash),
    occurrences: asInt(data.occurrences, { min: 1, max: 1_000_000 }),
    firstSeenAt,
    lastSeenAt,
    projectFingerprint: asFingerprint(data.projectFingerprint),
    scopeFingerprint: asFingerprint(data.scopeFingerprint),
    targetLogicalName: asTargetLogicalName(data.targetLogicalName),
  });
}

export function asTargetLogicalName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    fail("invalid-skill-name", "targetLogicalName must be an exact normalized skill name");
  }
  return value;
}

const STRUCTURED_SECRET_RE = /(?:-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[oprsu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b)/u;

function asSafeStructuredLabel(value, max) {
  const clean = asNonEmptyString(value, { max });
  if (STRUCTURED_SECRET_RE.test(clean)) fail("privacy-field-rejected", "structured field contains a secret marker");
  return clean;
}

const OBSERVATION_FIELDS = Object.freeze({
  receiptType: (value) => asEnum(value, RECEIPT_TYPES),
  scopeFingerprint: asFingerprint,
  occurrences: (value) => asInt(value, { min: 1, max: 1_000_000 }),
  eventKind: (value) => asSafeStructuredLabel(value, 64),
  commandSignatureHash: asSha256Hex,
  toolErrorCode: (value) => asSafeStructuredLabel(value, 128),
  procedureFingerprint: asFingerprint,
  clarificationCategory: (value) => asSafeStructuredLabel(value, 128),
  messageCount: (value) => asInt(value, { min: 0, max: 1_000_000 }),
  explicitUserSignal: (value) => asBoolean(value, "explicitUserSignal"),
  deterministicOutcome: (value) => asBoolean(value, "deterministicOutcome"),
  targetLogicalName: asTargetLogicalName,
});

function structuredObservationFields(value) {
  object(value, "structuredFields");
  const keys = Object.keys(value);
  if (keys.length > MAX.structuredKeys) fail("out-of-bounds", "structuredFields has too many fields");
  const output = { targetLogicalName: null };
  for (const key of keys.sort()) {
    if (!OBSERVATION_FIELDS[key]) fail("privacy-field-rejected", key);
    output[key] = OBSERVATION_FIELDS[key](value[key]);
  }
  return output;
}

export function makeObservation(data) {
  const optionalLegacyFields = new Set(["sessionLineageHash", "rootLineageHash", "originKind"]);
  exactKeys(data, Observation.fields, "Observation", Observation.fields.filter((field) => !optionalLegacyFields.has(field)));
  return deepFreeze({
    id: asSha256Hex(data.id),
    projectFingerprint: asFingerprint(data.projectFingerprint),
    receiptIds: boundedList(data.receiptIds, "receiptIds", MAX.receiptIds, asSha256Hex, { dedupe: true }),
    structuredFields: structuredObservationFields(data.structuredFields),
    incidentId: nonceString(data.incidentId),
    sessionLineageHash: asSha256Hex(data.sessionLineageHash ?? UNKNOWN_SESSION_LINEAGE_HASH),
    rootLineageHash: asSha256Hex(data.rootLineageHash ?? UNKNOWN_ROOT_LINEAGE_HASH),
    originKind: asEnum(data.originKind ?? "unknown", ORIGIN_KINDS),
    createdAt: asTimestamp(data.createdAt),
    injectionFlagged: asBoolean(data.injectionFlagged, "injectionFlagged"),
    redacted: asBoolean(data.redacted, "redacted"),
  });
}

export function makeEvidenceCluster(data) {
  exactKeys(data, EvidenceCluster.fields, "EvidenceCluster", EvidenceCluster.fields.filter((field) => field !== "targetLogicalName"));
  const firstSeenAt = asTimestamp(data.firstSeenAt);
  const lastSeenAt = asTimestamp(data.lastSeenAt);
  if (lastSeenAt < firstSeenAt) fail("out-of-order", "lastSeenAt precedes firstSeenAt");
  return deepFreeze({
    id: asSha256Hex(data.id),
    receiptType: asEnum(data.receiptType, RECEIPT_TYPES),
    projectFingerprint: asFingerprint(data.projectFingerprint),
    incidentIds: boundedList(data.incidentIds, "incidentIds", MAX.incidents, nonceString, { dedupe: true }),
    scopeFingerprint: asFingerprint(data.scopeFingerprint),
    targetLogicalName: asTargetLogicalName(data.targetLogicalName),
    occurrencesSum: asInt(data.occurrencesSum, { min: 0, max: 1_000_000_000 }),
    firstSeenAt,
    lastSeenAt,
  });
}

export function makeEligibilityExplanation(data) {
  exactKeys(data, EligibilityExplanation.fields, "EligibilityExplanation");
  return deepFreeze({
    clusterId: asSha256Hex(data.clusterId),
    eligible: asBoolean(data.eligible, "eligible"),
    reasons: boundedList(data.reasons, "reasons", MAX.reasons, (value) => asNonEmptyString(value, { max: MAX.reason }), { dedupe: true }),
    thresholdsMet: primitiveMap(data.thresholdsMet, "thresholdsMet"),
    thresholdsMissed: primitiveMap(data.thresholdsMissed, "thresholdsMissed"),
  });
}

function skillTarget(value) {
  exactKeys(value, ["canonicalRoot", "relativePath", "currentHash"], "skillTarget");
  const canonicalRoot = absolutePath(value.canonicalRoot);
  const relativePath = asPath(value.relativePath);
  if (relativePath.startsWith("/") || /^[A-Za-z]:\//.test(relativePath)) fail("malformed-payload", "relativePath must be relative");
  const currentHash = value.currentHash === "must-not-exist" ? value.currentHash : asSha256Hex(value.currentHash);
  return { canonicalRoot, relativePath, currentHash };
}

export function makeProposal(data) {
  exactKeys(data, Proposal.fields, "Proposal", Proposal.fields.slice(0, 13));
  return deepFreeze({
    id: idString(data.id),
    projectFingerprint: asFingerprint(data.projectFingerprint),
    clusterId: asSha256Hex(data.clusterId),
    skillTarget: skillTarget(data.skillTarget),
    proposedContentHash: asSha256Hex(data.proposedContentHash),
    rationaleText: byteBoundedString(data.rationaleText, MAX.rationale),
    synthesizedAt: asTimestamp(data.synthesizedAt),
    synthesizerModelId: asNonEmptyString(data.synthesizerModelId, { max: MAX.model }),
    criticScore: finiteNumber(data.criticScore, { min: 0, max: 1 }),
    criticPassed: asBoolean(data.criticPassed, "criticPassed"),
    validDeterministic: asBoolean(data.validDeterministic, "validDeterministic"),
    state: asEnum(data.state, PROPOSAL_STATES),
    injectionFlagged: asBoolean(data.injectionFlagged, "injectionFlagged"),
    decisionVersion: asInt(data.decisionVersion ?? 0, { min: 0, max: 1_000_000 }),
    burnedNonceHashes: boundedList(data.burnedNonceHashes, "burnedNonceHashes", MAX.burnedNonces, asSha256Hex, { dedupe: true, defaultValue: [] }),
  });
}

export function makeProposalContent(data) {
  exactKeys(data, ProposalContent.fields, "ProposalContent");
  const content = asString(data.content, { max: 512 });
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(content)) fail("malformed-payload", "content must be base64");
  if (Buffer.from(content, "base64").toString("base64") !== content) fail("malformed-payload", "content must be canonical base64");
  const chunkIndex = asInt(data.chunkIndex, { min: 0, max: 1_000_000 });
  const chunkCount = asInt(data.chunkCount, { min: 1, max: 1_000_000 });
  if (chunkIndex >= chunkCount) fail("malformed-payload", "chunkIndex must be less than chunkCount");
  return deepFreeze({
    proposalId: idString(data.proposalId),
    contentHash: asSha256Hex(data.contentHash),
    contentEncoding: asEnum(data.contentEncoding, ["base64"]),
    chunkIndex,
    chunkCount,
    content,
  });
}

export function makeSynthesisAttempt(data) {
  exactKeys(data, SynthesisAttempt.fields, "SynthesisAttempt");
  return deepFreeze({
    outcomeId: asSha256Hex(data.outcomeId),
    proposalId: idString(data.proposalId),
    projectFingerprint: asFingerprint(data.projectFingerprint),
    clusterId: asSha256Hex(data.clusterId),
    targetHash: data.targetHash === "must-not-exist" ? data.targetHash : asSha256Hex(data.targetHash),
    admittedAt: asTimestamp(data.admittedAt),
    state: asEnum(data.state, ["admitted"]),
  });
}

export function makeDecision(data) {
  exactKeys(data, Decision.fields, "Decision");
  return deepFreeze({
    proposalId: idString(data.proposalId),
    targetHash: data.targetHash === "must-not-exist" ? data.targetHash : asSha256Hex(data.targetHash),
    proposedContentHash: asSha256Hex(data.proposedContentHash),
    decisionVersion: asInt(data.decisionVersion, { min: 1, max: 1_000_000 }),
    actor: asNonEmptyString(data.actor, { max: MAX.actor }),
    timestamp: asTimestamp(data.timestamp),
    nonce: nonceString(data.nonce),
    priorState: asEnum(data.priorState, PROPOSAL_STATES),
    newState: asEnum(data.newState, PROPOSAL_STATES),
  });
}

export function burnNonce(decision) {
  const clean = makeDecision(decision);
  return asSha256Hex(sha256(clean.nonce));
}

const ALLOWED_TRANSITIONS = deepFreeze({
  "critic-pending": ["pending", "failed-closed"],
  pending: ["approved", "rejected", "superseded", "failed-closed"],
  approved: ["applied", "superseded", "failed-closed"],
  applied: ["rolled-back", "failed-closed"],
  rejected: [],
  "rolled-back": [],
  superseded: [],
  "failed-closed": [],
});

export function assertCasAllowed(decision, currentProposalState) {
  const clean = makeDecision(decision);
  const current = asEnum(currentProposalState, PROPOSAL_STATES);
  if (clean.priorState !== current) fail("stale-prior-state");
  if (!ALLOWED_TRANSITIONS[current].includes(clean.newState)) fail("invalid-transition", `${current}->${clean.newState}`);
  if (current === "critic-pending" && clean.newState === "pending" && clean.actor !== "self-evolve-critic") fail("unauthorized-actor");
  if (["applied", "rolled-back"].includes(clean.newState) && clean.actor !== "self-evolve-applier") fail("unauthorized-actor");
  return true;
}

export function makeApplyClaim(data) {
  exactKeys(data, ApplyClaim.fields, "ApplyClaim");
  const acquiredAt = asTimestamp(data.acquiredAt);
  const expiresAt = asTimestamp(data.expiresAt);
  if (expiresAt <= acquiredAt) fail("out-of-order", "claim must expire after acquisition");
  return deepFreeze({
    proposalId: idString(data.proposalId),
    leaseNonce: nonceString(data.leaseNonce),
    acquiredAt,
    expiresAt,
    actor: asNonEmptyString(data.actor, { max: MAX.actor }),
  });
}

export function isExpired(claim, now) {
  return makeApplyClaim(claim).expiresAt <= asTimestamp(now);
}

export function oneActiveClaimPerProposal(claims) {
  const clean = boundedList(claims, "claims", MAX.list, makeApplyClaim);
  const seen = new Set();
  for (const claim of clean) {
    if (seen.has(claim.proposalId)) fail("lease-conflict", claim.proposalId);
    seen.add(claim.proposalId);
  }
  return true;
}

export function makeAuditEvent(data) {
  exactKeys(data, AuditEvent.fields, "AuditEvent", ["id", "kind", "actor", "timestamp", "payloadHash", "details"]);
  return deepFreeze({
    id: asSha256Hex(data.id),
    kind: asEnum(data.kind, AUDIT_KINDS),
    ...(data.proposalId === undefined ? {} : { proposalId: idString(data.proposalId) }),
    actor: asNonEmptyString(data.actor, { max: MAX.actor }),
    timestamp: asTimestamp(data.timestamp),
    payloadHash: asSha256Hex(data.payloadHash),
    details: primitiveMap(data.details, "details"),
  });
}

export function makeSynthesisOutcomeAuditEvent(data) {
  exactKeys(data, ["outcomeId", "projectFingerprint", "clusterId", "status", "success", "terminalAt", "reasonCode"], "SynthesisOutcome");
  const outcomeId = asSha256Hex(data.outcomeId);
  const projectFingerprint = asFingerprint(data.projectFingerprint);
  const clusterId = asSha256Hex(data.clusterId);
  const status = asEnum(data.status, SYNTHESIS_OUTCOME_STATUSES);
  const success = asBoolean(data.success, "success");
  const terminalAt = asTimestamp(data.terminalAt);
  const reasonCode = asEnum(data.reasonCode, SYNTHESIS_OUTCOME_REASON_CODES[status]);
  if (success !== ["accepted", "no-change"].includes(status)) fail("invalid-synthesis-outcome-success");
  const details = primitiveMap({ action: "synthesis-outcome", outcomeId, projectFingerprint, clusterId, status, success, terminalAt, reasonCode }, "details");
  const payloadHash = sha256(canonicalize(details));
  return makeAuditEvent({
    id: sha256(`synthesis-outcome-audit-v1\n${outcomeId}`),
    kind: "decision",
    actor: "self-evolve-pipeline",
    timestamp: terminalAt,
    payloadHash,
    details,
  });
}

export function parseSynthesisOutcomeAuditEvent(value) {
  try {
    const event = makeAuditEvent(value);
    const details = event.details;
    exactKeys(details, ["action", "outcomeId", "projectFingerprint", "clusterId", "status", "success", "terminalAt", "reasonCode"], "SynthesisOutcome.details");
    if (details.action !== "synthesis-outcome" || event.kind !== "decision" || event.actor !== "self-evolve-pipeline" || event.proposalId !== undefined) return null;
    const { action: _action, ...outcome } = details;
    const expected = makeSynthesisOutcomeAuditEvent(outcome);
    return canonicalize(event) === canonicalize(expected) ? expected.details : null;
  } catch {
    return null;
  }
}

function audit(kind, actor, timestamp, details, proposalId) {
  const body = { kind, actor, timestamp, details: primitiveMap(details, "details"), ...(proposalId ? { proposalId } : {}) };
  const payloadHash = sha256(canonicalize(body.details));
  return makeAuditEvent({ ...body, id: sha256(canonicalize({ ...body, payloadHash })), payloadHash });
}

export function makeRollbackRecord(data) {
  exactKeys(data, RollbackRecord.fields, "RollbackRecord");
  return deepFreeze({
    proposalId: idString(data.proposalId),
    appliedHash: asSha256Hex(data.appliedHash),
    rolledBackAt: asTimestamp(data.rolledBackAt),
    reason: asNonEmptyString(data.reason, { max: MAX.reason }),
  });
}

export function makeInterventionEpoch(data) {
  exactKeys(data, InterventionEpoch.fields, "InterventionEpoch");
  return deepFreeze({
    epochId: nonceString(data.epochId),
    startedAt: asTimestamp(data.startedAt),
    reason: asNonEmptyString(data.reason, { max: MAX.reason }),
  });
}

export function makeCircuitBreaker(data = {}) {
  exactKeys(data, CircuitBreaker.fields, "CircuitBreaker", ["open", "tripCount"]);
  const open = asBoolean(data.open, "open");
  if (open && (data.openedAt === undefined || data.reason === undefined)) fail("malformed-payload", "open breaker needs openedAt and reason");
  if (!open && (data.openedAt !== undefined || data.reason !== undefined)) fail("malformed-payload", "closed breaker cannot retain open metadata");
  return deepFreeze({
    open,
    ...(open ? { openedAt: asTimestamp(data.openedAt), reason: asNonEmptyString(data.reason, { max: MAX.reason }) } : {}),
    tripCount: asInt(data.tripCount, { min: 0, max: 1_000_000 }),
  });
}

export function trip(breaker, reason, now) {
  const current = makeCircuitBreaker(breaker);
  return makeCircuitBreaker({ open: true, openedAt: asTimestamp(now), reason: asNonEmptyString(reason, { max: MAX.reason }), tripCount: current.tripCount + 1 });
}

export function reset(breaker) {
  const current = makeCircuitBreaker(breaker);
  return makeCircuitBreaker({ open: false, tripCount: current.tripCount });
}

const RECORD_VALIDATORS = {
  "global-settings": makeGlobalSettings,
  "repo-settings": makeRepoSettings,
  "episode-cursor": makeEpisodeCursor,
  receipt: makeReceipt,
  observation: makeObservation,
  "evidence-cluster": makeEvidenceCluster,
  "eligibility-explanation": makeEligibilityExplanation,
  proposal: makeProposal,
  "proposal-content": makeProposalContent,
  "synthesis-attempt": makeSynthesisAttempt,
  decision: makeDecision,
  "apply-claim": makeApplyClaim,
  "audit-event": makeAuditEvent,
  "rollback-record": makeRollbackRecord,
  "intervention-epoch": makeInterventionEpoch,
  "circuit-breaker": makeCircuitBreaker,
};

export function wrapRecord(kind, payload, now) {
  const cleanKind = asEnum(kind, RECORD_KINDS);
  const cleanPayload = RECORD_VALIDATORS[cleanKind](payload);
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    kind: cleanKind,
    id: sha256(`${cleanKind}\n${canonicalize(cleanPayload)}`),
    createdAt: asTimestamp(now),
    payload: cleanPayload,
  });
}

export function assertRecord(envelope) {
  exactKeys(envelope, ["schemaVersion", "kind", "id", "createdAt", "payload"], "record envelope");
  schemaVersion(envelope.schemaVersion);
  const expected = wrapRecord(envelope.kind, envelope.payload, envelope.createdAt);
  const actualId = asSha256Hex(envelope.id);
  if (actualId !== expected.id) {
    const legacyTargetOmitted = (envelope.kind === "receipt" || envelope.kind === "evidence-cluster")
      ? !Object.hasOwn(envelope.payload, "targetLogicalName")
      : envelope.kind === "observation"
        && isObject(envelope.payload.structuredFields)
        && !Object.hasOwn(envelope.payload.structuredFields, "targetLogicalName");
    const legacyId = legacyTargetOmitted ? sha256(`${envelope.kind}\n${canonicalize(envelope.payload)}`) : null;
    if (actualId !== legacyId) fail("corrupt-record");
  }
  return expected;
}

export function transitionMode(currentGlobal, currentRepo, requested, now, actor) {
  try {
    const global = makeGlobalSettings(currentGlobal);
    const repo = makeRepoSettings(currentRepo);
    const request = typeof requested === "string" ? { scope: "global", mode: requested } : requested;
    exactKeys(request, ["scope", "mode", "overrides"], "mode request", ["scope", "mode"]);
    const scope = asEnum(request.scope, ["global", "repo"]);
    const mode = scope === "repo" ? asEnum(request.mode, REPO_MODES) : asMode(request.mode);
    const timestamp = asTimestamp(now);
    const cleanActor = asNonEmptyString(actor, { max: MAX.actor });
    if (scope === "global" && Number.isFinite(global.updatedAt) && timestamp < global.updatedAt) fail("stale-timestamp", "mode transition timestamp is older than the current settings version");
    const nextGlobal = scope === "global" ? makeGlobalSettings({ ...global, mode, updatedAt: timestamp }) : global;
    const nextRepo = scope === "repo" ? makeRepoSettings({ ...repo, mode }) : repo;
    const suppliedOverrides = request.overrides ?? {};
    const effectiveMode = resolveMode(nextGlobal.mode, nextRepo.mode, {
      ...suppliedOverrides,
      killSwitchActive: nextGlobal.killSwitchActive || suppliedOverrides.killSwitchActive === true,
      paused: nextGlobal.paused || suppliedOverrides.paused === true,
      processExcluded: nextRepo.excluded || suppliedOverrides.processExcluded === true,
    });
    const state = deepFreeze({ global: nextGlobal, repo: nextRepo, effectiveMode, unattendedApplyAllowed: effectiveMode === "yolo" });
    const event = audit("mode-change", cleanActor, timestamp, { scope, requestedMode: mode, effectiveMode });
    return { ok: true, state, events: [event] };
  } catch (error) {
    return { ok: false, state: deepFreeze({ global: currentGlobal, repo: currentRepo, effectiveMode: "manual" }), events: [], error: error.message };
  }
}

export function transitionProposalState(proposal, decision, now) {
  try {
    const current = makeProposal(proposal);
    const change = makeDecision(decision);
    const timestamp = asTimestamp(now);
    if (change.timestamp > timestamp) fail("out-of-order", "decision is from the future");
    if (change.proposalId !== current.id) fail("cross-scope", "proposal id mismatch");
    if (change.targetHash !== current.skillTarget.currentHash || change.proposedContentHash !== current.proposedContentHash) fail("cross-scope", "hash binding mismatch");
    if (change.decisionVersion !== current.decisionVersion + 1) fail("stale-decision-version");
    assertCasAllowed(change, current.state);
    if (change.newState === "applied" && (!current.criticPassed || !current.validDeterministic || current.injectionFlagged)) fail("release-gates-failed");
    const nonceHash = burnNonce(change);
    if (current.burnedNonceHashes.includes(nonceHash)) fail("replayed-decision");
    const state = makeProposal({
      ...current,
      state: change.newState,
      decisionVersion: change.decisionVersion,
      burnedNonceHashes: [...current.burnedNonceHashes, nonceHash],
    });
    return { ok: true, state, events: [audit("decision", change.actor, timestamp, { priorState: change.priorState, newState: change.newState, decisionVersion: change.decisionVersion, nonceHash }, current.id)] };
  } catch (error) {
    return { ok: false, state: proposal, events: [], error: error.message };
  }
}

export function acquireApplyClaim(claims, proposal, now, ttlMs, actor) {
  try {
    const current = makeProposal(proposal);
    const timestamp = asTimestamp(now);
    const ttl = asInt(ttlMs, { min: 1, max: 3_600_000 });
    const cleanActor = asNonEmptyString(actor, { max: MAX.actor });
    if (cleanActor !== "self-evolve-applier") fail("unauthorized-actor");
    if (current.state !== "approved") fail("proposal-not-approved");
    if (!current.criticPassed || !current.validDeterministic || current.injectionFlagged) fail("release-gates-failed");
    const cleanClaims = boundedList(claims, "claims", MAX.list, makeApplyClaim);
    if (cleanClaims.some((claim) => claim.proposalId === current.id && !isExpired(claim, timestamp))) fail("lease-conflict");
    const leaseNonce = sha256(canonicalize({ proposalId: current.id, timestamp, ttl, actor: cleanActor }));
    const claim = makeApplyClaim({ proposalId: current.id, leaseNonce, acquiredAt: timestamp, expiresAt: timestamp + ttl, actor: cleanActor });
    const state = deepFreeze([...cleanClaims.filter((item) => item.proposalId !== current.id && !isExpired(item, timestamp)), claim]);
    return { ok: true, state, events: [audit("lease", cleanActor, timestamp, { action: "acquire", leaseNonce }, current.id)] };
  } catch (error) {
    return { ok: false, state: claims, events: [], error: error.message };
  }
}

export function releaseApplyClaim(claim, reason) {
  try {
    const current = makeApplyClaim(claim);
    const cleanReason = asNonEmptyString(reason, { max: MAX.reason });
    return { ok: true, state: null, events: [audit("lease", current.actor, current.acquiredAt, { action: "release", reason: cleanReason, leaseNonce: current.leaseNonce }, current.proposalId)] };
  } catch (error) {
    return { ok: false, state: claim, events: [], error: error.message };
  }
}

export function recordIncident(cluster, observation, now) {
  try {
    const current = makeEvidenceCluster(cluster);
    const incident = makeObservation(observation);
    const timestamp = asTimestamp(now);
    if (incident.projectFingerprint !== current.projectFingerprint) fail("cross-scope", "project fingerprint mismatch");
    if (incident.structuredFields.receiptType !== current.receiptType
      || incident.structuredFields.scopeFingerprint !== current.scopeFingerprint
      || (incident.structuredFields.targetLogicalName ?? null) !== current.targetLogicalName) fail("cross-scope", "correlation key mismatch");
    if (incident.createdAt > timestamp) fail("out-of-order", "observation is from the future");
    if (current.incidentIds.includes(incident.incidentId)) return { ok: true, state: current, events: [] };
    if (current.incidentIds.length >= MAX.incidents) fail("out-of-bounds", "incidentIds is full");
    const state = makeEvidenceCluster({
      ...current,
      incidentIds: [...current.incidentIds, incident.incidentId],
      occurrencesSum: current.occurrencesSum + (incident.structuredFields.occurrences ?? 1),
      firstSeenAt: Math.min(current.firstSeenAt, incident.createdAt),
      lastSeenAt: Math.max(current.lastSeenAt, incident.createdAt),
    });
    return { ok: true, state, events: [] };
  } catch (error) {
    return { ok: false, state: cluster, events: [], error: error.message };
  }
}

export function assertEligibility(cluster, thresholds) {
  const current = makeEvidenceCluster(cluster);
  exactKeys(thresholds, ["minIncidents", "minOccurrences"], "thresholds", []);
  const requiredIncidents = asInt(thresholds.minIncidents ?? 3, { min: 1, max: MAX.incidents });
  const requiredOccurrences = asInt(thresholds.minOccurrences ?? 3, { min: 1, max: 1_000_000 });
  const values = { incidentCount: current.incidentIds.length, occurrencesSum: current.occurrencesSum };
  const met = {};
  const missed = {};
  (values.incidentCount >= requiredIncidents ? met : missed).minIncidents = requiredIncidents;
  (values.occurrencesSum >= requiredOccurrences ? met : missed).minOccurrences = requiredOccurrences;
  const eligible = Object.keys(missed).length === 0;
  return makeEligibilityExplanation({
    clusterId: current.id,
    eligible,
    reasons: eligible ? ["all-thresholds-met"] : Object.keys(missed).map((key) => `${key}-not-met`),
    thresholdsMet: met,
    thresholdsMissed: missed,
  });
}

export function evaluateApplyAuthority({ mode, decisionApproved = false, allowlisted = false, releaseGatesPassed = false, headless = false, killSwitchActive = false } = {}) {
  let cleanMode;
  try { cleanMode = asMode(mode); } catch { cleanMode = "manual"; }
  if ([decisionApproved, allowlisted, releaseGatesPassed, headless, killSwitchActive].some((value) => typeof value !== "boolean")) {
    return deepFreeze({ allowed: false, reason: "ambiguous-authority" });
  }
  if (killSwitchActive || cleanMode === "manual") return deepFreeze({ allowed: false, reason: killSwitchActive ? "kill-switch" : "manual-advisory-only" });
  if (cleanMode === "auto") {
    return deepFreeze({ allowed: decisionApproved, reason: decisionApproved ? "explicit-decision" : "decision-required" });
  }
  if (!allowlisted) return deepFreeze({ allowed: false, reason: "scope-not-allowlisted" });
  if (!releaseGatesPassed) return deepFreeze({ allowed: false, reason: "release-gates-failed" });
  return deepFreeze({ allowed: true, reason: "yolo-release-gates-passed" });
}

export function downgradeOnKillSwitch(state) {
  try {
    object(state, "runtime state");
    exactKeys(state, ["storedMode", "effectiveMode", "yoloApplicationEnabled", "killSwitchActive", "actor", "timestamp"], "runtime state", ["storedMode", "effectiveMode", "yoloApplicationEnabled", "killSwitchActive", "actor", "timestamp"]);
    const storedMode = asMode(state.storedMode);
    const effectiveMode = asMode(state.effectiveMode);
    const timestamp = asTimestamp(state.timestamp);
    const actor = asNonEmptyString(state.actor, { max: MAX.actor });
    const next = deepFreeze({ ...state, storedMode, effectiveMode: "manual", yoloApplicationEnabled: false, killSwitchActive: true, actor, timestamp });
    const changed = effectiveMode !== "manual" || state.yoloApplicationEnabled || !state.killSwitchActive;
    return { ok: true, state: next, events: changed ? [audit("kill-switch", actor, timestamp, { storedMode, priorEffectiveMode: effectiveMode, effectiveMode: "manual" })] : [] };
  } catch (error) {
    return { ok: false, state, events: [], error: error.message };
  }
}
