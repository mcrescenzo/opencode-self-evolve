import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "0.3.0";
// Earlier schema versions whose persisted records and settings the current validators still read.
// Values are normalized to SCHEMA_VERSION on read, so durable state written by a previous release
// is migrated in place instead of being quarantined as damaged. Record identity is content-addressed
// over kind+payload only, so re-stamping the version never changes an id; assertRecord still rejects
// any record whose payload fails to round-trip. Only list a version here once its records are known
// to re-wrap to an identical id under the current validators.
// v0.2 generations are migration input only: they are read, re-stamped to the
// writable 0.3.0 generation, and never written again.
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(["0.2.0", "0.2.1", "0.2.2", SCHEMA_VERSION]);
export const V3_VERSION_CONTRACT = deepFreeze({
  packageVersion: "0.3.0",
  tuiVersion: "0.3.0",
  stateSchemaVersion: "0.3.0",
  migrationInputVersions: ["0.2.0", "0.2.1", "0.2.2"],
  writableStateVersions: ["0.3.0"],
  legacyWritableAuthority: false,
});
export const V3_PROTOCOL_CONTRACT = deepFreeze({
  globalBridgeSchemaVersion: 1,
  globalProjectionVersion: 1,
  globalOperationVersion: 1,
  globalDecisionVersion: 1,
  globalFeedbackVersion: 1,
  globalTransactionVersion: 1,
  projectAnalysisControlVersion: 1,
  projectParticipationVersion: 1,
  legacyCompatibilityInputs: ["bridge-schema-0.2.1", "bridge-schema-0.2.2", "project-operation-v1", "project-projection-v1"],
  capabilities: [
    "global-action-grant-v1",
    "global-action-request-v1",
    "global-recommendation-detail-v1",
    "global-recommendation-index-v1",
    "global-transaction-v1",
    "project-analysis-control-v1",
    "project-participation-v1",
  ],
});
export const V3_ELIGIBILITY_THRESHOLDS = deepFreeze({
  singleDomain: { independentIncidents: 2, occurrences: 3, nonUnknownUserRootLineages: 2, freshnessRatio: 0.5 },
  distributed: { independentKnownDomains: 2, independentIncidents: 3 },
});
export const V3_RETENTION_DEFAULTS = deepFreeze({
  projectEvidenceDays: 30,
  evidenceCapsuleDays: 30,
  globalContributionDays: 30,
  globalCandidateDays: 30,
  globalRecommendationDays: 90,
  globalAuditDays: 90,
  bridgeArtifactHours: 24,
  actingMetadataTtlMs: 60_000,
  leaseMaxTtlMs: 3_600_000,
});
export const UNKNOWN_SESSION_LINEAGE_HASH = createHash("sha256").update("self-evolve-session-lineage-v1\nunknown").digest("hex");
export const UNKNOWN_ROOT_LINEAGE_HASH = createHash("sha256").update("self-evolve-root-lineage-v1\nunknown").digest("hex");
export const UNKNOWN_EVIDENCE_DOMAIN_ID = createHash("sha256").update("self-evolve-evidence-domain-v1\nlocal-unknown").digest("hex");
export const MAX_RATIONALE_BYTES = 2048;
export const MAX_EVIDENCE_CAPSULE_BYTES = 240;

const MAX = Object.freeze({
  string: 1024,
  path: 1024,
  actor: 128,
  reason: 512,
  rationale: MAX_RATIONALE_BYTES,
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
const MAX_GLOBAL_FORBIDDEN_IDENTITIES = 4096;

// v0.3 installations only configure `manual` and `auto`. Legacy `yolo` remains a
// readable migration input that narrows to `auto` and never carries unattended
// write authority; it can never be written or advertised again.
const MODES = Object.freeze(["manual", "auto"]);
const LEGACY_MODE_INPUTS = Object.freeze([...MODES, "yolo"]);
const REPO_MODES = Object.freeze([...MODES, "inherit"]);
const LEGACY_REPO_MODE_INPUTS = Object.freeze([...LEGACY_MODE_INPUTS, "inherit"]);
const PROJECT_ANALYSIS_MODES = Object.freeze(["manual", "auto"]);
const PROJECT_ANALYSIS_OVERRIDES = Object.freeze(["inherit", ...PROJECT_ANALYSIS_MODES]);
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
  tokensPerSynthesis: 24576,
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
  return narrowLegacyMode(asEnum(value, LEGACY_MODE_INPUTS));
}

export function asRepoMode(value) {
  return narrowLegacyMode(asEnum(value, LEGACY_REPO_MODE_INPUTS));
}

function narrowLegacyMode(value) {
  return value === "yolo" ? "auto" : value;
}

export function asProjectAnalysisMode(value) {
  return asEnum(value, PROJECT_ANALYSIS_MODES);
}

export function asProjectAnalysisOverride(value) {
  return asEnum(value, PROJECT_ANALYSIS_OVERRIDES);
}

export function normalizeLegacyProjectAnalysisMode(value) {
  const legacy = asEnum(value, LEGACY_MODE_INPUTS);
  return deepFreeze({
    mode: legacy === "yolo" ? "auto" : asProjectAnalysisMode(legacy),
    unattendedWriteAllowed: false,
    migratedFrom: legacy === "yolo" ? "yolo" : null,
  });
}

function v3SchemaVersion(value = V3_VERSION_CONTRACT.stateSchemaVersion) {
  if (value !== V3_VERSION_CONTRACT.stateSchemaVersion) fail("unsupported-v3-schema-version", String(value));
  return value;
}

export function makeApprovedGlobalRoot(data) {
  exactKeys(data, ["rootId", "canonicalPath", "canUpdate", "canCreate"], "ApprovedGlobalRoot", ["canonicalPath", "canUpdate", "canCreate"]);
  const canonicalPath = absolutePath(data.canonicalPath);
  const rootId = sha256(`self-evolve-global-root-v1\n${canonicalPath}`);
  if (data.rootId !== undefined && asSha256Hex(data.rootId) !== rootId) fail("root-id-mismatch");
  const canUpdate = asBoolean(data.canUpdate, "canUpdate");
  const canCreate = asBoolean(data.canCreate, "canCreate");
  if (!canUpdate && !canCreate) fail("invalid-root-capability", "approved roots need update or create authority");
  return deepFreeze({ rootId, canonicalPath, canUpdate, canCreate });
}

export function makeGlobalRootPolicy(data) {
  const fields = ["schemaVersion", "roots", "creationRootId", "selectedBy", "updatedAt", "rootSetHash"];
  exactKeys(data, fields, "GlobalRootPolicy", ["roots", "creationRootId", "selectedBy", "updatedAt"]);
  const roots = boundedList(data.roots, "roots", MAX.roots, makeApprovedGlobalRoot);
  if (roots.length === 0) fail("out-of-bounds", "roots needs at least one approved root");
  if (new Set(roots.map((root) => root.rootId)).size !== roots.length) fail("duplicate-root-id");
  if (new Set(roots.map((root) => root.canonicalPath)).size !== roots.length) fail("duplicate-root-path");
  const creationRootId = data.creationRootId === null ? null : asSha256Hex(data.creationRootId);
  const creationRoots = roots.filter((root) => root.canCreate);
  if (creationRootId === null) {
    if (creationRoots.length !== 0) fail("creation-root-mismatch", "create capability requires a primary creation root");
  } else if (creationRoots.length !== 1 || creationRoots[0].rootId !== creationRootId) {
    fail("creation-root-mismatch", "creationRootId must name the sole create-capable root");
  }
  const rootSetHash = sha256(`self-evolve-global-root-set-v1\n${canonicalize({ roots, creationRootId })}`);
  if (data.rootSetHash !== undefined && asSha256Hex(data.rootSetHash) !== rootSetHash) fail("root-set-hash-mismatch");
  return deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    roots,
    creationRootId,
    selectedBy: asEnum(data.selectedBy, ["operator"]),
    updatedAt: asTimestamp(data.updatedAt),
    rootSetHash,
  });
}

export function makeCandidateTargetBinding(data, rootPolicy) {
  const fields = ["targetKind", "rootId", "logicalName", "relativePath", "currentHash", "catalogGenerationHash", "rootSetHash", "bindingHash"];
  exactKeys(data, fields, "CandidateTargetBinding", fields.filter((field) => field !== "bindingHash"));
  const policy = makeGlobalRootPolicy(rootPolicy);
  const targetKind = asEnum(data.targetKind, ["existing-global-skill", "new-global-skill"]);
  const rootId = asSha256Hex(data.rootId);
  const root = policy.roots.find((item) => item.rootId === rootId);
  if (!root) fail("unapproved-global-root");
  if (asSha256Hex(data.rootSetHash) !== policy.rootSetHash) fail("stale-root-set");
  let logicalName;
  let relativePath;
  let currentHash;
  if (targetKind === "existing-global-skill") {
    if (!root.canUpdate) fail("target-binding-not-authorized", "root cannot update existing skills");
    logicalName = asTargetLogicalName(data.logicalName);
    if (logicalName === null) fail("target-binding-invalid", "existing targets need a logical name");
    relativePath = asPath(data.relativePath);
    if (relativePath !== `${logicalName}/SKILL.md`) fail("target-binding-invalid", "existing target path must be the exact direct child skill path");
    if (data.currentHash === "must-not-exist") fail("target-binding-invalid", "existing targets need a current content hash");
    currentHash = asSha256Hex(data.currentHash);
  } else {
    if (policy.creationRootId !== rootId || !root.canCreate) fail("creation-root-mismatch");
    if (data.logicalName !== null || data.relativePath !== null || data.currentHash !== "must-not-exist") {
      fail("target-binding-invalid", "new candidate targets bind only the creation root before synthesis");
    }
    logicalName = null;
    relativePath = null;
    currentHash = "must-not-exist";
  }
  const binding = {
    targetKind,
    rootId,
    logicalName,
    relativePath,
    currentHash,
    catalogGenerationHash: asSha256Hex(data.catalogGenerationHash),
    rootSetHash: policy.rootSetHash,
  };
  const bindingHash = sha256(`self-evolve-candidate-target-v1\n${canonicalize(binding)}`);
  if (data.bindingHash !== undefined && asSha256Hex(data.bindingHash) !== bindingHash) fail("target-binding-hash-mismatch");
  return deepFreeze({ ...binding, bindingHash });
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
  fields: ["schemaVersion", "mode", "createdAt", "updatedAt", "paused", "killSwitchActive", "allowedSkillRoots", "globalRootPolicy", "consent", "budgets", "retentionDays"],
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
export const EvidenceDomain = deepFreeze({ fields: ["domainId", "lineageStatus", "sourceLineageHash", "distributedEligible"] });
export const EvidenceCapsule = deepFreeze({
  fields: ["schemaVersion", "capsuleId", "incidentId", "receiptType", "targetLogicalName", "summary", "summaryHash", "createdAt", "expiresAt"],
});
export const ContributionIntent = deepFreeze({
  fields: ["schemaVersion", "intentId", "contributionId", "incidentId", "capsuleId", "clusterId", "evidenceDomainId", "consentVersionHash", "state", "createdAt", "updatedAt"],
});
export const ProjectContributionLink = deepFreeze({
  fields: ["schemaVersion", "contributionId", "intentId", "incidentId", "capsuleId", "clusterId", "evidenceDomainId", "linkedAt", "state"],
});
export const GlobalContribution = deepFreeze({
  fields: ["schemaVersion", "contributionId", "claimType", "receiptType", "signatureHash", "occurrenceCount", "firstSeenDay", "lastSeenDay", "createdAt", "expiresAt"],
});
export const GlobalSupportSet = deepFreeze({
  fields: ["schemaVersion", "supportSetHash", "candidateId", "targetBinding", "contributionIds", "strongestSingleDomain", "distributed", "integrity", "firstSeenDay", "lastSeenDay", "evaluatedAt", "expiresAt"],
});
export const GlobalEligibility = deepFreeze({
  fields: ["eligible", "route", "reasons", "singleDomainEligible", "distributedEligible", "supportSetHash", "targetBindingHash"],
});
export const GlobalCandidate = deepFreeze({
  fields: ["schemaVersion", "candidateId", "claimType", "receiptType", "signatureHash", "targetBindingHash", "supportSetHash", "state", "eligibilityRoute", "independentDomainCount", "independentIncidentCount", "occurrenceCount", "firstSeenDay", "lastSeenDay", "createdAt", "updatedAt"],
});
export const GlobalRecommendation = deepFreeze({
  fields: ["schemaVersion", "recommendationId", "candidateId", "supportSetHash", "candidateTargetBindingHash", "targetBinding", "proposedContentHash", "rationaleText", "synthesizedAt", "synthesizerModelId", "criticScore", "criticPassed", "validDeterministic", "state", "decisionVersion", "burnedNonceHashes"],
});
export const GlobalRecommendationContent = deepFreeze({
  fields: ["schemaVersion", "recommendationId", "contentHash", "contentEncoding", "chunkIndex", "chunkCount", "content"],
});
export const GlobalDecision = deepFreeze({
  fields: ["schemaVersion", "recommendationId", "supportSetHash", "targetBindingHash", "targetHash", "proposedContentHash", "decisionVersion", "actorRole", "timestamp", "nonce", "priorState", "newState"],
});
export const GlobalApplyIntent = deepFreeze({
  fields: ["schemaVersion", "intentId", "action", "recommendationId", "supportSetHash", "targetBindingHash", "rootId", "relativePath", "targetKind", "priorHash", "appliedHash", "decision", "state", "temporaryName", "snapshotId", "directoryDevice", "directoryInode", "createdAt", "updatedAt"],
});
export const GlobalSkillSnapshot = deepFreeze({
  fields: ["schemaVersion", "snapshotId", "intentId", "recommendationId", "targetBindingHash", "rootId", "relativePath", "priorHash", "appliedHash", "contentHash", "contentEncoding", "content", "createdAt"],
});
export const GlobalDecisionOutcome = deepFreeze({
  fields: ["schemaVersion", "outcomeId", "intentId", "action", "recommendationId", "decisionVersion", "state", "priorHash", "appliedHash", "auditId", "completedAt", "reason"],
});
export const GlobalSynthesisAttempt = deepFreeze({
  fields: ["schemaVersion", "attemptId", "candidateId", "supportSetHash", "targetBindingHash", "state", "admittedAt", "updatedAt"],
});
export const GlobalLease = deepFreeze({
  fields: ["schemaVersion", "leaseId", "leaseKind", "leaseKeyHash", "ownerToken", "state", "acquiredAt", "expiresAt", "releasedAt"],
});
export const ProjectAnalysisSettings = deepFreeze({ fields: ["schemaVersion", "projectFingerprint", "override", "updatedAt"] });
export const V3RetentionPolicy = deepFreeze({ fields: ["schemaVersion", ...Object.keys(V3_RETENTION_DEFAULTS)] });
export const GlobalActionRequest = deepFreeze({
  fields: ["protocolVersion", "capability", "requestId", "stateRootIdentity", "actingProjectFingerprint", "actingHealthHash", "projectionGenerationHash", "indexHash", "detailHash", "grantHash", "recommendationId", "recommendationVersion", "supportSetHash", "targetBindingHash", "targetHash", "proposedContentHash", "priorState", "action", "actorRole", "issuedAt", "expiresAt", "nonce", "requestHash"],
});
export const GlobalConsumerClaim = deepFreeze({
  fields: ["protocolVersion", "claimId", "requestId", "consumerInstanceId", "consumerProjectFingerprint", "state", "acquiredAt", "expiresAt", "releasedAt"],
});
export const GlobalAuditEvent = deepFreeze({
  fields: ["schemaVersion", "auditId", "kind", "recommendationId", "actorRole", "timestamp", "supportSetHash", "targetBindingHash", "proposedContentHash", "decisionVersion", "outcome"],
});
export const V3PurgeOperation = deepFreeze({
  fields: ["schemaVersion", "operationId", "scope", "actingProjectFingerprint", "recommendationId", "state", "actorRole", "requestedAt", "updatedAt", "nonce", "confirmation"],
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
    globalRootPolicy: data.globalRootPolicy === null || data.globalRootPolicy === undefined
      ? null
      : makeGlobalRootPolicy(data.globalRootPolicy),
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
    mode: asRepoMode(data.mode ?? "inherit"),
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

export function asOpaqueRandomId(value) {
  if (typeof value !== "string") fail("invalid-opaque-id");
  const clean = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(clean)) fail("invalid-opaque-id");
  return clean;
}

function globalValidationContext(options = {}) {
  exactKeys(options, ["forbiddenIdentityValues"], "global validation context", []);
  const forbiddenIdentityValues = boundedList(
    options.forbiddenIdentityValues,
    "forbiddenIdentityValues",
    MAX_GLOBAL_FORBIDDEN_IDENTITIES,
    (value) => asNonEmptyString(value, { max: MAX.path }),
    { dedupe: true, defaultValue: [] },
  );
  return { forbiddenIdentityValues };
}

function isForbiddenGlobalIdentityKey(key) {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (!/(?:id|hash|fingerprint|path)$/u.test(normalized)) return false;
  return [
    "project", "repository", "repo", "worktree", "source", "scope", "sourcedomain", "evidencedomain",
    "capsule", "cluster", "observation", "session", "localincident", "incident",
  ].some((prefix) => normalized.includes(prefix));
}

export function assertGlobalIdentitySafe(value, options = {}) {
  const { forbiddenIdentityValues } = globalValidationContext(options);
  const forbidden = new Set(forbiddenIdentityValues.flatMap((item) => [item, item.toLowerCase()]));
  const embedded = forbiddenIdentityValues.filter((item) => item.length >= 16).map((item) => item.toLowerCase());
  const visit = (item) => {
    if (typeof item === "string") {
      const lower = item.toLowerCase();
      if (forbidden.has(item) || forbidden.has(lower) || embedded.some((identity) => lower.includes(identity))) fail("forbidden-global-identity", "identity-derived value");
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isObject(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (isForbiddenGlobalIdentityKey(key)) fail("forbidden-global-identity", key);
      visit(child);
    }
  };
  visit(value);
  return true;
}

export function makeEvidenceDomain(data) {
  exactKeys(data, EvidenceDomain.fields, "EvidenceDomain", ["lineageStatus", "sourceLineageHash"]);
  const lineageStatus = asEnum(data.lineageStatus, ["known", "unknown", "ambiguous"]);
  let sourceLineageHash;
  let domainId;
  let distributedEligible;
  if (lineageStatus === "known") {
    sourceLineageHash = asSha256Hex(data.sourceLineageHash);
    domainId = sha256(`self-evolve-evidence-domain-v1\n${sourceLineageHash}`);
    distributedEligible = true;
  } else {
    if (data.sourceLineageHash !== null) fail("unknown-lineage-must-collapse");
    sourceLineageHash = null;
    domainId = UNKNOWN_EVIDENCE_DOMAIN_ID;
    distributedEligible = false;
  }
  if (data.domainId !== undefined && asSha256Hex(data.domainId) !== domainId) fail("evidence-domain-id-mismatch");
  if (data.distributedEligible !== undefined && asBoolean(data.distributedEligible, "distributedEligible") !== distributedEligible) fail("evidence-domain-authority-mismatch");
  return deepFreeze({ domainId, lineageStatus, sourceLineageHash, distributedEligible });
}

function evidenceCapsuleSummary(value) {
  const summary = byteBoundedString(value, MAX_EVIDENCE_CAPSULE_BYTES);
  if (STRUCTURED_SECRET_RE.test(summary)
      || /```|~~~/u.test(summary)
      || /(?:^|\s)(?:\/(?:[^/\s]+\/)*[^/\s]+|[A-Za-z]:[\\/][^\s]+)/u.test(summary)
      || /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system)\s+instructions?\b/iu.test(summary)
      || /(?:\/self-evolve|\bself-evolve\b)/iu.test(summary)
      || /\b(?:customer|client|tenant|repository|repo|project|private)[-_:\s]+[a-z0-9][a-z0-9._-]{2,}\b/iu.test(summary)) {
    fail("privacy-field-rejected", "evidence capsule summary contains prohibited material");
  }
  return summary;
}

export function makeEvidenceCapsule(data) {
  exactKeys(data, EvidenceCapsule.fields, "EvidenceCapsule", EvidenceCapsule.fields.filter((field) => !["schemaVersion", "summaryHash"].includes(field)));
  const createdAt = asTimestamp(data.createdAt);
  const expiresAt = asTimestamp(data.expiresAt);
  if (expiresAt <= createdAt) fail("out-of-order", "capsule must expire after creation");
  const summary = evidenceCapsuleSummary(data.summary);
  const summaryHash = sha256(summary);
  if (data.summaryHash !== undefined && asSha256Hex(data.summaryHash) !== summaryHash) fail("capsule-summary-hash-mismatch");
  return deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    capsuleId: asOpaqueRandomId(data.capsuleId),
    incidentId: idString(data.incidentId, "incidentId"),
    receiptType: asEnum(data.receiptType, RECEIPT_TYPES),
    targetLogicalName: asTargetLogicalName(data.targetLogicalName),
    summary,
    summaryHash,
    createdAt,
    expiresAt,
  });
}

const CONTRIBUTION_INTENT_TRANSITIONS = deepFreeze({
  allocated: ["published", "revoked", "failed-closed"],
  published: ["linked", "revoked", "failed-closed"],
  linked: ["committed", "revoked", "failed-closed"],
  committed: ["revoked"],
  revoked: [],
  "failed-closed": [],
});

export function makeContributionIntent(data) {
  exactKeys(data, ContributionIntent.fields, "ContributionIntent", ContributionIntent.fields.filter((field) => field !== "schemaVersion"));
  const createdAt = asTimestamp(data.createdAt);
  const updatedAt = asTimestamp(data.updatedAt);
  if (updatedAt < createdAt) fail("out-of-order", "intent update precedes creation");
  return deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    intentId: asOpaqueRandomId(data.intentId),
    contributionId: asOpaqueRandomId(data.contributionId),
    incidentId: idString(data.incidentId, "incidentId"),
    capsuleId: asOpaqueRandomId(data.capsuleId),
    clusterId: asSha256Hex(data.clusterId),
    evidenceDomainId: asSha256Hex(data.evidenceDomainId),
    consentVersionHash: asSha256Hex(data.consentVersionHash),
    state: asEnum(data.state, Object.keys(CONTRIBUTION_INTENT_TRANSITIONS)),
    createdAt,
    updatedAt,
  });
}

export function transitionContributionIntent(intent, nextState, now) {
  const current = makeContributionIntent(intent);
  const next = asEnum(nextState, Object.keys(CONTRIBUTION_INTENT_TRANSITIONS));
  const updatedAt = asTimestamp(now);
  if (updatedAt < current.updatedAt) fail("out-of-order", "intent transition precedes current version");
  if (!CONTRIBUTION_INTENT_TRANSITIONS[current.state].includes(next)) fail("invalid-transition", `${current.state}->${next}`);
  return makeContributionIntent({ ...current, state: next, updatedAt });
}

export function makeProjectContributionLink(data) {
  exactKeys(data, ProjectContributionLink.fields, "ProjectContributionLink", ProjectContributionLink.fields.filter((field) => field !== "schemaVersion"));
  return deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    contributionId: asOpaqueRandomId(data.contributionId),
    intentId: asOpaqueRandomId(data.intentId),
    incidentId: idString(data.incidentId, "incidentId"),
    capsuleId: asOpaqueRandomId(data.capsuleId),
    clusterId: asSha256Hex(data.clusterId),
    evidenceDomainId: asSha256Hex(data.evidenceDomainId),
    linkedAt: asTimestamp(data.linkedAt),
    state: asEnum(data.state, ["active", "revoked"]),
  });
}

export function makeGlobalContribution(data, options = {}) {
  exactKeys(data, GlobalContribution.fields, "GlobalContribution", GlobalContribution.fields.filter((field) => field !== "schemaVersion"));
  const firstSeenDay = utcDay(data.firstSeenDay, "firstSeenDay");
  const lastSeenDay = utcDay(data.lastSeenDay, "lastSeenDay");
  const createdAt = asTimestamp(data.createdAt);
  const expiresAt = asTimestamp(data.expiresAt);
  if (lastSeenDay < firstSeenDay) fail("out-of-order", "lastSeenDay precedes firstSeenDay");
  if (expiresAt <= createdAt) fail("out-of-order", "contribution must expire after creation");
  const contribution = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    contributionId: asOpaqueRandomId(data.contributionId),
    claimType: asEnum(data.claimType, AGGREGATE_CLAIM_TYPES),
    receiptType: asEnum(data.receiptType, RECEIPT_TYPES),
    signatureHash: asSha256Hex(data.signatureHash),
    occurrenceCount: asInt(data.occurrenceCount, { min: 1, max: 1_000_000 }),
    firstSeenDay,
    lastSeenDay,
    createdAt,
    expiresAt,
  });
  assertGlobalIdentitySafe(contribution, options);
  return contribution;
}

export function assertContributionPublicationBinding(intent, contribution, options = {}) {
  const localIntent = makeContributionIntent(intent);
  const globalContribution = makeGlobalContribution(contribution, options);
  if (!["allocated", "published", "linked", "committed"].includes(localIntent.state)) fail("contribution-intent-not-publishable");
  if (localIntent.contributionId !== globalContribution.contributionId) fail("contribution-intent-mismatch");
  return true;
}

function storedCandidateTargetBinding(data) {
  const fields = ["targetKind", "rootId", "logicalName", "relativePath", "currentHash", "catalogGenerationHash", "rootSetHash", "bindingHash"];
  exactKeys(data, fields, "CandidateTargetBinding");
  const targetKind = asEnum(data.targetKind, ["existing-global-skill", "new-global-skill"]);
  const rootId = asSha256Hex(data.rootId);
  let logicalName;
  let relativePath;
  let currentHash;
  if (targetKind === "existing-global-skill") {
    logicalName = asTargetLogicalName(data.logicalName);
    if (logicalName === null) fail("target-binding-invalid");
    relativePath = asPath(data.relativePath);
    if (relativePath !== `${logicalName}/SKILL.md`) fail("target-binding-invalid");
    if (data.currentHash === "must-not-exist") fail("target-binding-invalid");
    currentHash = asSha256Hex(data.currentHash);
  } else {
    if (data.logicalName !== null || data.relativePath !== null || data.currentHash !== "must-not-exist") fail("target-binding-invalid");
    logicalName = null;
    relativePath = null;
    currentHash = "must-not-exist";
  }
  const binding = {
    targetKind,
    rootId,
    logicalName,
    relativePath,
    currentHash,
    catalogGenerationHash: asSha256Hex(data.catalogGenerationHash),
    rootSetHash: asSha256Hex(data.rootSetHash),
  };
  const bindingHash = sha256(`self-evolve-candidate-target-v1\n${canonicalize(binding)}`);
  if (asSha256Hex(data.bindingHash) !== bindingHash) fail("target-binding-hash-mismatch");
  return deepFreeze({ ...binding, bindingHash });
}

function strongestSingleDomain(value) {
  const fields = ["lineageClass", "independentIncidentCount", "occurrenceCount", "nonUnknownUserRootLineageCount", "freshnessRatio"];
  exactKeys(value, fields, "StrongestSingleDomain");
  return deepFreeze({
    lineageClass: asEnum(value.lineageClass, ["known", "local-unknown"]),
    independentIncidentCount: asInt(value.independentIncidentCount, { min: 0, max: 1_000_000 }),
    occurrenceCount: asInt(value.occurrenceCount, { min: 0, max: 1_000_000_000 }),
    nonUnknownUserRootLineageCount: asInt(value.nonUnknownUserRootLineageCount, { min: 0, max: 1_000_000 }),
    freshnessRatio: finiteNumber(value.freshnessRatio, { min: 0, max: 1 }),
  });
}

function distributedSupport(value) {
  const fields = ["independentKnownDomainCount", "independentIncidentCount", "unknownLineageCollapsed"];
  exactKeys(value, fields, "DistributedSupport");
  return deepFreeze({
    independentKnownDomainCount: asInt(value.independentKnownDomainCount, { min: 0, max: 1_000_000 }),
    independentIncidentCount: asInt(value.independentIncidentCount, { min: 0, max: 1_000_000 }),
    unknownLineageCollapsed: asBoolean(value.unknownLineageCollapsed, "unknownLineageCollapsed"),
  });
}

function supportIntegrity(value) {
  const fields = ["contradictionFree", "injectionFree", "chronologyValid", "correlationValid"];
  exactKeys(value, fields, "SupportIntegrity");
  return deepFreeze({
    contradictionFree: asBoolean(value.contradictionFree, "contradictionFree"),
    injectionFree: asBoolean(value.injectionFree, "injectionFree"),
    chronologyValid: asBoolean(value.chronologyValid, "chronologyValid"),
    correlationValid: asBoolean(value.correlationValid, "correlationValid"),
  });
}

export function makeGlobalSupportSet(data, options = {}) {
  exactKeys(data, GlobalSupportSet.fields, "GlobalSupportSet", GlobalSupportSet.fields.filter((field) => !["schemaVersion", "supportSetHash"].includes(field)));
  const firstSeenDay = utcDay(data.firstSeenDay, "firstSeenDay");
  const lastSeenDay = utcDay(data.lastSeenDay, "lastSeenDay");
  const evaluatedAt = asTimestamp(data.evaluatedAt);
  const expiresAt = asTimestamp(data.expiresAt);
  if (lastSeenDay < firstSeenDay) fail("out-of-order", "lastSeenDay precedes firstSeenDay");
  if (expiresAt <= evaluatedAt) fail("out-of-order", "support set must expire after evaluation");
  const body = {
    candidateId: asSha256Hex(data.candidateId),
    targetBinding: storedCandidateTargetBinding(data.targetBinding),
    contributionIds: boundedList(data.contributionIds, "contributionIds", MAX.incidents, asOpaqueRandomId, { dedupe: true })
      .sort(),
    strongestSingleDomain: strongestSingleDomain(data.strongestSingleDomain),
    distributed: distributedSupport(data.distributed),
    integrity: supportIntegrity(data.integrity),
    firstSeenDay,
    lastSeenDay,
    evaluatedAt,
    expiresAt,
  };
  if (body.contributionIds.length === 0) fail("out-of-bounds", "support set needs at least one opaque contribution");
  const hashBody = { ...body };
  delete hashBody.evaluatedAt;
  const supportSetHash = sha256(`self-evolve-global-support-set-v1\n${canonicalize(hashBody)}`);
  if (data.supportSetHash !== undefined && asSha256Hex(data.supportSetHash) !== supportSetHash) fail("support-set-hash-mismatch");
  const supportSet = deepFreeze({ schemaVersion: v3SchemaVersion(data.schemaVersion), supportSetHash, ...body });
  assertGlobalIdentitySafe(supportSet, options);
  return supportSet;
}

export function evaluateGlobalSupportEligibility(value, rootPolicy) {
  const supportSet = makeGlobalSupportSet(value);
  makeCandidateTargetBinding(supportSet.targetBinding, rootPolicy);
  const integrityPassed = Object.values(supportSet.integrity).every((item) => item === true);
  const single = supportSet.strongestSingleDomain;
  const singleDomainEligible = integrityPassed
    && single.independentIncidentCount >= V3_ELIGIBILITY_THRESHOLDS.singleDomain.independentIncidents
    && single.occurrenceCount >= V3_ELIGIBILITY_THRESHOLDS.singleDomain.occurrences
    && single.nonUnknownUserRootLineageCount >= V3_ELIGIBILITY_THRESHOLDS.singleDomain.nonUnknownUserRootLineages
    && single.freshnessRatio >= V3_ELIGIBILITY_THRESHOLDS.singleDomain.freshnessRatio;
  const distributed = supportSet.distributed;
  const distributedEligible = integrityPassed
    && distributed.independentKnownDomainCount >= V3_ELIGIBILITY_THRESHOLDS.distributed.independentKnownDomains
    && distributed.independentIncidentCount >= V3_ELIGIBILITY_THRESHOLDS.distributed.independentIncidents;
  const route = singleDomainEligible ? "single-domain" : distributedEligible ? "distributed" : null;
  const reasons = [];
  if (!integrityPassed) reasons.push("integrity-gate-failed");
  if (!singleDomainEligible) reasons.push("single-domain-threshold-not-met");
  if (!distributedEligible) reasons.push("distributed-threshold-not-met");
  if (route) reasons.unshift(`${route}-threshold-met`);
  return deepFreeze({
    eligible: route !== null,
    route,
    reasons,
    singleDomainEligible,
    distributedEligible,
    supportSetHash: supportSet.supportSetHash,
    targetBindingHash: supportSet.targetBinding.bindingHash,
  });
}

const GLOBAL_CANDIDATE_STATES = Object.freeze([
  "collecting", "eligible", "synthesis-pending", "recommended", "no-change", "rejected", "failed-closed", "superseded",
]);

export function makeGlobalCandidate(data, options = {}) {
  exactKeys(data, GlobalCandidate.fields, "GlobalCandidate", GlobalCandidate.fields.filter((field) => !["schemaVersion", "candidateId"].includes(field)));
  const firstSeenDay = utcDay(data.firstSeenDay, "firstSeenDay");
  const lastSeenDay = utcDay(data.lastSeenDay, "lastSeenDay");
  const createdAt = asTimestamp(data.createdAt);
  const updatedAt = asTimestamp(data.updatedAt);
  if (lastSeenDay < firstSeenDay) fail("out-of-order", "lastSeenDay precedes firstSeenDay");
  if (updatedAt < createdAt) fail("out-of-order", "candidate update precedes creation");
  const claimType = asEnum(data.claimType, AGGREGATE_CLAIM_TYPES);
  const receiptType = asEnum(data.receiptType, RECEIPT_TYPES);
  const signatureHash = asSha256Hex(data.signatureHash);
  const targetBindingHash = asSha256Hex(data.targetBindingHash);
  const candidateId = sha256(`self-evolve-global-candidate-v1\n${canonicalize({ claimType, receiptType, signatureHash, targetBindingHash })}`);
  if (data.candidateId !== undefined && asSha256Hex(data.candidateId) !== candidateId) fail("candidate-id-mismatch");
  const state = asEnum(data.state, GLOBAL_CANDIDATE_STATES);
  const eligibilityRoute = data.eligibilityRoute === null ? null : asEnum(data.eligibilityRoute, ["single-domain", "distributed"]);
  if (["eligible", "synthesis-pending", "recommended", "no-change"].includes(state) && eligibilityRoute === null) fail("candidate-eligibility-missing");
  if (state === "collecting" && eligibilityRoute !== null) fail("candidate-eligibility-invalid");
  const candidate = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    candidateId,
    claimType,
    receiptType,
    signatureHash,
    targetBindingHash,
    supportSetHash: asSha256Hex(data.supportSetHash),
    state,
    eligibilityRoute,
    independentDomainCount: asInt(data.independentDomainCount, { min: 0, max: 1_000_000 }),
    independentIncidentCount: asInt(data.independentIncidentCount, { min: 0, max: 1_000_000 }),
    occurrenceCount: asInt(data.occurrenceCount, { min: 0, max: 1_000_000_000 }),
    firstSeenDay,
    lastSeenDay,
    createdAt,
    updatedAt,
  });
  assertGlobalIdentitySafe(candidate, options);
  return candidate;
}

const GLOBAL_CANDIDATE_TRANSITIONS = deepFreeze({
  collecting: ["eligible", "superseded"],
  eligible: ["synthesis-pending", "collecting", "superseded"],
  "synthesis-pending": ["recommended", "no-change", "failed-closed", "collecting", "superseded"],
  recommended: ["rejected", "failed-closed", "superseded"],
  "no-change": ["eligible", "superseded"],
  rejected: ["eligible", "superseded"],
  "failed-closed": ["eligible", "superseded"],
  superseded: [],
});

export function transitionGlobalCandidate(candidate, change, now) {
  const current = makeGlobalCandidate(candidate);
  exactKeys(change, ["state", "supportSetHash", "eligibilityRoute"], "GlobalCandidateTransition");
  const state = asEnum(change.state, GLOBAL_CANDIDATE_STATES);
  if (!GLOBAL_CANDIDATE_TRANSITIONS[current.state].includes(state)) fail("invalid-transition", `${current.state}->${state}`);
  const supportSetHash = asSha256Hex(change.supportSetHash);
  if (["no-change", "rejected", "failed-closed"].includes(current.state) && state === "eligible" && supportSetHash === current.supportSetHash) fail("support-set-unchanged");
  const updatedAt = asTimestamp(now);
  if (updatedAt < current.updatedAt) fail("out-of-order", "candidate transition precedes current version");
  return makeGlobalCandidate({
    ...current,
    supportSetHash,
    state,
    eligibilityRoute: change.eligibilityRoute,
    updatedAt,
  });
}

export function makeRecommendationTargetBinding(data, candidateTarget, rootPolicy) {
  const fields = ["targetKind", "rootId", "logicalName", "relativePath", "currentHash", "catalogGenerationHash", "rootSetHash", "candidateBindingHash", "bindingHash"];
  exactKeys(data, fields, "RecommendationTargetBinding", fields.filter((field) => field !== "bindingHash"));
  const candidate = makeCandidateTargetBinding(candidateTarget, rootPolicy);
  const policy = makeGlobalRootPolicy(rootPolicy);
  const candidateBindingHash = asSha256Hex(data.candidateBindingHash);
  if (candidateBindingHash !== candidate.bindingHash) fail("candidate-target-binding-mismatch");
  if (data.targetKind !== candidate.targetKind
      || asSha256Hex(data.rootId) !== candidate.rootId
      || asSha256Hex(data.catalogGenerationHash) !== candidate.catalogGenerationHash
      || asSha256Hex(data.rootSetHash) !== candidate.rootSetHash) {
    fail("target-binding-mismatch");
  }
  const root = policy.roots.find((item) => item.rootId === candidate.rootId);
  let logicalName;
  let relativePath;
  let currentHash;
  if (candidate.targetKind === "existing-global-skill") {
    logicalName = asTargetLogicalName(data.logicalName);
    relativePath = asPath(data.relativePath);
    currentHash = asSha256Hex(data.currentHash);
    if (logicalName !== candidate.logicalName || relativePath !== candidate.relativePath || currentHash !== candidate.currentHash) fail("target-binding-mismatch");
  } else {
    if (!root?.canCreate || policy.creationRootId !== candidate.rootId) fail("creation-root-mismatch");
    logicalName = asTargetLogicalName(data.logicalName);
    if (logicalName === null) fail("target-binding-invalid", "new recommendation needs a validated logical name");
    relativePath = asPath(data.relativePath);
    if (relativePath !== `${logicalName}/SKILL.md` || data.currentHash !== "must-not-exist") fail("target-binding-invalid");
    currentHash = "must-not-exist";
  }
  const binding = {
    targetKind: candidate.targetKind,
    rootId: candidate.rootId,
    logicalName,
    relativePath,
    currentHash,
    catalogGenerationHash: candidate.catalogGenerationHash,
    rootSetHash: candidate.rootSetHash,
    candidateBindingHash,
  };
  const bindingHash = sha256(`self-evolve-recommendation-target-v1\n${canonicalize(binding)}`);
  if (data.bindingHash !== undefined && asSha256Hex(data.bindingHash) !== bindingHash) fail("target-binding-hash-mismatch");
  return deepFreeze({ ...binding, bindingHash });
}

function storedRecommendationTargetBinding(data) {
  const fields = ["targetKind", "rootId", "logicalName", "relativePath", "currentHash", "catalogGenerationHash", "rootSetHash", "candidateBindingHash", "bindingHash"];
  exactKeys(data, fields, "RecommendationTargetBinding");
  const targetKind = asEnum(data.targetKind, ["existing-global-skill", "new-global-skill"]);
  const logicalName = asTargetLogicalName(data.logicalName);
  if (logicalName === null) fail("target-binding-invalid");
  const relativePath = asPath(data.relativePath);
  if (relativePath !== `${logicalName}/SKILL.md`) fail("target-binding-invalid");
  const currentHash = targetKind === "new-global-skill"
    ? data.currentHash === "must-not-exist" ? data.currentHash : fail("target-binding-invalid")
    : asSha256Hex(data.currentHash);
  const binding = {
    targetKind,
    rootId: asSha256Hex(data.rootId),
    logicalName,
    relativePath,
    currentHash,
    catalogGenerationHash: asSha256Hex(data.catalogGenerationHash),
    rootSetHash: asSha256Hex(data.rootSetHash),
    candidateBindingHash: asSha256Hex(data.candidateBindingHash),
  };
  const bindingHash = sha256(`self-evolve-recommendation-target-v1\n${canonicalize(binding)}`);
  if (asSha256Hex(data.bindingHash) !== bindingHash) fail("target-binding-hash-mismatch");
  return deepFreeze({ ...binding, bindingHash });
}

const GLOBAL_RECOMMENDATION_STATES = Object.freeze([
  "critic-pending", "pending", "approved", "applied", "undo-approved", "rejected", "rolled-back", "superseded", "failed-closed",
]);

export function makeGlobalRecommendation(data, options = {}) {
  exactKeys(data, GlobalRecommendation.fields, "GlobalRecommendation", GlobalRecommendation.fields.filter((field) => !["schemaVersion", "recommendationId"].includes(field)));
  const candidateId = asSha256Hex(data.candidateId);
  const supportSetHash = asSha256Hex(data.supportSetHash);
  const candidateTargetBindingHash = asSha256Hex(data.candidateTargetBindingHash);
  const targetBinding = storedRecommendationTargetBinding(data.targetBinding);
  if (targetBinding.candidateBindingHash !== candidateTargetBindingHash) fail("candidate-target-binding-mismatch");
  const proposedContentHash = asSha256Hex(data.proposedContentHash);
  const recommendationId = sha256(`self-evolve-global-recommendation-v1\n${canonicalize({ candidateId, supportSetHash, candidateTargetBindingHash, targetBindingHash: targetBinding.bindingHash, proposedContentHash })}`);
  if (data.recommendationId !== undefined && asSha256Hex(data.recommendationId) !== recommendationId) fail("recommendation-id-mismatch");
  const recommendation = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    recommendationId,
    candidateId,
    supportSetHash,
    candidateTargetBindingHash,
    targetBinding,
    proposedContentHash,
    rationaleText: byteBoundedString(data.rationaleText, MAX.rationale),
    synthesizedAt: asTimestamp(data.synthesizedAt),
    synthesizerModelId: asNonEmptyString(data.synthesizerModelId, { max: MAX.model }),
    criticScore: finiteNumber(data.criticScore, { min: 0, max: 1 }),
    criticPassed: asBoolean(data.criticPassed, "criticPassed"),
    validDeterministic: asBoolean(data.validDeterministic, "validDeterministic"),
    state: asEnum(data.state, GLOBAL_RECOMMENDATION_STATES),
    decisionVersion: asInt(data.decisionVersion, { min: 0, max: 1_000_000 }),
    burnedNonceHashes: boundedList(data.burnedNonceHashes, "burnedNonceHashes", MAX.burnedNonces, asSha256Hex, { dedupe: true }),
  });
  assertGlobalIdentitySafe(recommendation, options);
  return recommendation;
}

export function makeGlobalRecommendationContent(data, options = {}) {
  exactKeys(data, GlobalRecommendationContent.fields, "GlobalRecommendationContent", GlobalRecommendationContent.fields.filter((field) => field !== "schemaVersion"));
  const content = asString(data.content, { max: 512 });
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(content) || Buffer.from(content, "base64").toString("base64") !== content) fail("malformed-payload", "content must be canonical base64");
  const chunkIndex = asInt(data.chunkIndex, { min: 0, max: 1_000_000 });
  const chunkCount = asInt(data.chunkCount, { min: 1, max: 1_000_000 });
  if (chunkIndex >= chunkCount) fail("malformed-payload", "chunkIndex must be less than chunkCount");
  const record = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    recommendationId: asSha256Hex(data.recommendationId),
    contentHash: asSha256Hex(data.contentHash),
    contentEncoding: asEnum(data.contentEncoding, ["base64"]),
    chunkIndex,
    chunkCount,
    content,
  });
  assertGlobalIdentitySafe(record, options);
  return record;
}

export function makeGlobalDecision(data, options = {}) {
  exactKeys(data, GlobalDecision.fields, "GlobalDecision", GlobalDecision.fields.filter((field) => field !== "schemaVersion"));
  const decision = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    recommendationId: asSha256Hex(data.recommendationId),
    supportSetHash: asSha256Hex(data.supportSetHash),
    targetBindingHash: asSha256Hex(data.targetBindingHash),
    targetHash: data.targetHash === "must-not-exist" ? data.targetHash : asSha256Hex(data.targetHash),
    proposedContentHash: asSha256Hex(data.proposedContentHash),
    decisionVersion: asInt(data.decisionVersion, { min: 1, max: 1_000_000 }),
    actorRole: asEnum(data.actorRole, ["operator", "critic", "applier", "policy"]),
    timestamp: asTimestamp(data.timestamp),
    nonce: nonceString(data.nonce),
    priorState: asEnum(data.priorState, GLOBAL_RECOMMENDATION_STATES),
    newState: asEnum(data.newState, GLOBAL_RECOMMENDATION_STATES),
  });
  assertGlobalIdentitySafe(decision, options);
  return decision;
}

export function globalDecisionId(decision) {
  return sha256(`self-evolve-global-decision-v1\n${canonicalize(makeGlobalDecision(decision))}`);
}

export function globalApplyIntentId(decision) {
  const clean = makeGlobalDecision(decision);
  if (clean.actorRole !== "operator" || !["approved", "undo-approved"].includes(clean.newState)) {
    fail("invalid-global-operator-decision");
  }
  return sha256(`self-evolve-global-apply-intent-v1\n${canonicalize(clean)}`);
}

const GLOBAL_APPLY_INTENT_STATES = Object.freeze([
  "decision-pending", "decision-committed", "snapshot-ready", "temp-written", "published", "readback-verified", "completed", "failed-closed",
]);

export function makeGlobalApplyIntent(data, options = {}) {
  exactKeys(
    data,
    GlobalApplyIntent.fields,
    "GlobalApplyIntent",
    GlobalApplyIntent.fields.filter((field) => !["schemaVersion", "intentId"].includes(field)),
  );
  const decision = makeGlobalDecision(data.decision, options);
  const action = asEnum(data.action, ["apply", "undo"]);
  if (decision.actorRole !== "operator"
      || (action === "apply" && (decision.priorState !== "pending" || decision.newState !== "approved"))
      || (action === "undo" && (decision.priorState !== "applied" || decision.newState !== "undo-approved"))) {
    fail("global-intent-decision-mismatch");
  }
  const recommendationId = asSha256Hex(data.recommendationId);
  const supportSetHash = asSha256Hex(data.supportSetHash);
  const targetBindingHash = asSha256Hex(data.targetBindingHash);
  const priorHash = data.priorHash === "must-not-exist" ? data.priorHash : asSha256Hex(data.priorHash);
  const appliedHash = asSha256Hex(data.appliedHash);
  if (recommendationId !== decision.recommendationId || supportSetHash !== decision.supportSetHash
      || targetBindingHash !== decision.targetBindingHash || appliedHash !== decision.proposedContentHash
      || decision.targetHash !== (action === "apply" ? priorHash : appliedHash)) {
    fail("global-intent-decision-binding-mismatch");
  }
  const rootId = asSha256Hex(data.rootId);
  const relativePath = asPath(data.relativePath);
  const targetKind = asEnum(data.targetKind, ["existing-global-skill", "new-global-skill"]);
  if (relativePath.split("/").length !== 2 || !relativePath.endsWith("/SKILL.md")) fail("target-binding-invalid");
  if ((targetKind === "new-global-skill") !== (priorHash === "must-not-exist")) fail("target-binding-invalid");
  const state = asEnum(data.state, GLOBAL_APPLY_INTENT_STATES);
  const temporaryName = data.temporaryName === null ? null : asNonEmptyString(data.temporaryName, { max: 255 });
  if (temporaryName !== null && (temporaryName.includes("/") || temporaryName.includes("\\") || !temporaryName.startsWith("."))) {
    fail("invalid-global-temporary-name");
  }
  const snapshotId = data.snapshotId === null ? null : asSha256Hex(data.snapshotId);
  if (targetKind === "new-global-skill" && snapshotId !== null) fail("snapshot-target-mismatch");
  const canonicalDirectoryNumber = (value, label) => {
    if (value === null) return null;
    const clean = asNonEmptyString(value, { max: 32 });
    if (!/^(?:0|[1-9][0-9]*)$/u.test(clean)) fail("invalid-global-directory-identity", label);
    return clean;
  };
  const directoryDevice = canonicalDirectoryNumber(data.directoryDevice, "directoryDevice");
  const directoryInode = canonicalDirectoryNumber(data.directoryInode, "directoryInode");
  if ((directoryDevice === null) !== (directoryInode === null)
      || (directoryDevice !== null && (targetKind !== "new-global-skill" || action !== "apply"))) {
    fail("invalid-global-directory-identity");
  }
  const createdAt = asTimestamp(data.createdAt);
  const updatedAt = asTimestamp(data.updatedAt);
  if (updatedAt < createdAt) fail("out-of-order", "intent update precedes creation");
  const intentId = globalApplyIntentId(decision);
  if (data.intentId !== undefined && asSha256Hex(data.intentId) !== intentId) fail("global-apply-intent-id-mismatch");
  const intent = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion), intentId, action, recommendationId, supportSetHash,
    targetBindingHash, rootId, relativePath, targetKind, priorHash, appliedHash, decision, state,
    temporaryName, snapshotId, directoryDevice, directoryInode, createdAt, updatedAt,
  });
  assertGlobalIdentitySafe(intent, options);
  return intent;
}

const GLOBAL_APPLY_INTENT_TRANSITIONS = deepFreeze({
  "decision-pending": ["decision-committed", "failed-closed"],
  "decision-committed": ["snapshot-ready", "failed-closed"],
  "snapshot-ready": ["temp-written", "failed-closed"],
  "temp-written": ["published", "failed-closed"],
  published: ["readback-verified", "failed-closed"],
  "readback-verified": ["completed", "failed-closed"],
  completed: [],
  "failed-closed": [],
});

export function transitionGlobalApplyIntent(intent, change, now) {
  const current = makeGlobalApplyIntent(intent);
  exactKeys(change, ["state", "temporaryName", "snapshotId", "directoryDevice", "directoryInode"], "GlobalApplyIntentTransition", ["state"]);
  const state = asEnum(change.state, GLOBAL_APPLY_INTENT_STATES);
  if (!GLOBAL_APPLY_INTENT_TRANSITIONS[current.state].includes(state)) fail("invalid-transition", `${current.state}->${state}`);
  const updatedAt = asTimestamp(now);
  if (updatedAt < current.updatedAt) fail("out-of-order", "intent transition precedes current version");
  return makeGlobalApplyIntent({
    ...current,
    state,
    temporaryName: change.temporaryName === undefined ? current.temporaryName : change.temporaryName,
    snapshotId: change.snapshotId === undefined ? current.snapshotId : change.snapshotId,
    directoryDevice: change.directoryDevice === undefined ? current.directoryDevice : change.directoryDevice,
    directoryInode: change.directoryInode === undefined ? current.directoryInode : change.directoryInode,
    updatedAt,
  });
}

export function makeGlobalSkillSnapshot(data, options = {}) {
  exactKeys(data, GlobalSkillSnapshot.fields, "GlobalSkillSnapshot", GlobalSkillSnapshot.fields.filter((field) => !["schemaVersion", "snapshotId", "contentHash"].includes(field)));
  const content = asString(data.content, { max: 128 * 1024 });
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(content) || Buffer.from(content, "base64").toString("base64") !== content) {
    fail("malformed-payload", "snapshot content must be canonical base64");
  }
  const contentHash = sha256(Buffer.from(content, "base64"));
  const body = {
    intentId: asSha256Hex(data.intentId),
    recommendationId: asSha256Hex(data.recommendationId),
    targetBindingHash: asSha256Hex(data.targetBindingHash),
    rootId: asSha256Hex(data.rootId),
    relativePath: asPath(data.relativePath),
    priorHash: asSha256Hex(data.priorHash),
    appliedHash: asSha256Hex(data.appliedHash),
    contentHash,
    contentEncoding: asEnum(data.contentEncoding, ["base64"]),
    content,
    createdAt: asTimestamp(data.createdAt),
  };
  if (body.contentHash !== body.priorHash) fail("global-snapshot-hash-mismatch");
  const snapshotId = sha256(`self-evolve-global-skill-snapshot-v1\n${canonicalize(body)}`);
  if (data.snapshotId !== undefined && asSha256Hex(data.snapshotId) !== snapshotId) fail("global-snapshot-id-mismatch");
  const snapshot = deepFreeze({ schemaVersion: v3SchemaVersion(data.schemaVersion), snapshotId, ...body });
  assertGlobalIdentitySafe(Buffer.from(content, "base64").toString("utf8"), options);
  assertGlobalIdentitySafe(snapshot, options);
  return snapshot;
}

export function globalDecisionOutcomeId(intentId) {
  return sha256(`self-evolve-global-decision-outcome-v1\n${asSha256Hex(intentId)}`);
}

export function makeGlobalDecisionOutcome(data, options = {}) {
  exactKeys(data, GlobalDecisionOutcome.fields, "GlobalDecisionOutcome", GlobalDecisionOutcome.fields.filter((field) => !["schemaVersion", "outcomeId"].includes(field)));
  const intentId = asSha256Hex(data.intentId);
  const outcomeId = globalDecisionOutcomeId(intentId);
  if (data.outcomeId !== undefined && asSha256Hex(data.outcomeId) !== outcomeId) fail("global-decision-outcome-id-mismatch");
  const outcome = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    outcomeId,
    intentId,
    action: asEnum(data.action, ["apply", "undo"]),
    recommendationId: asSha256Hex(data.recommendationId),
    decisionVersion: asInt(data.decisionVersion, { min: 1, max: 1_000_000 }),
    state: asEnum(data.state, ["succeeded", "failed-closed"]),
    priorHash: data.priorHash === "must-not-exist" ? data.priorHash : asSha256Hex(data.priorHash),
    appliedHash: asSha256Hex(data.appliedHash),
    auditId: asSha256Hex(data.auditId),
    completedAt: asTimestamp(data.completedAt),
    reason: asEnum(data.reason, [
      "applied",
      "undone",
      "global-authority-revoked",
      "global-target-changed",
      "global-storage-capacity",
      "global-publication-failed",
      "global-decision-failed",
    ]),
  });
  assertGlobalIdentitySafe(outcome, options);
  return outcome;
}

const GLOBAL_RECOMMENDATION_TRANSITIONS = deepFreeze({
  "critic-pending": { pending: "critic", "failed-closed": "policy" },
  pending: { approved: "operator", rejected: "operator", superseded: "policy", "failed-closed": "policy" },
  approved: { applied: "applier", superseded: "policy", "failed-closed": "policy" },
  applied: { "undo-approved": "operator", "failed-closed": "policy" },
  "undo-approved": { "rolled-back": "applier", "failed-closed": "policy" },
  rejected: {},
  "rolled-back": {},
  superseded: { rejected: "operator" },
  "failed-closed": {},
});

export function transitionGlobalRecommendation(recommendation, decision, now) {
  try {
    const current = makeGlobalRecommendation(recommendation);
    const change = makeGlobalDecision(decision);
    const timestamp = asTimestamp(now);
    const expectedTargetHash = ["applied", "undo-approved"].includes(current.state)
      ? current.proposedContentHash
      : current.targetBinding.currentHash;
    if (change.timestamp > timestamp) fail("out-of-order", "decision is from the future");
    if (change.recommendationId !== current.recommendationId
        || change.supportSetHash !== current.supportSetHash
        || change.targetBindingHash !== current.targetBinding.bindingHash
        || change.targetHash !== expectedTargetHash
        || change.proposedContentHash !== current.proposedContentHash) fail("cross-scope", "global decision binding mismatch");
    if (change.decisionVersion !== current.decisionVersion + 1) fail("stale-decision-version");
    if (change.priorState !== current.state) fail("stale-prior-state");
    const actorRole = GLOBAL_RECOMMENDATION_TRANSITIONS[current.state]?.[change.newState];
    if (!actorRole) fail("invalid-transition", `${current.state}->${change.newState}`);
    if (change.actorRole !== actorRole) fail("unauthorized-actor");
    if (["applied", "rolled-back"].includes(change.newState) && (!current.criticPassed || !current.validDeterministic)) fail("release-gates-failed");
    const nonceHash = sha256(change.nonce);
    if (current.burnedNonceHashes.includes(nonceHash)) fail("replayed-decision");
    const state = makeGlobalRecommendation({
      ...current,
      state: change.newState,
      decisionVersion: change.decisionVersion,
      burnedNonceHashes: [...current.burnedNonceHashes, nonceHash],
    });
    return { ok: true, state, events: [] };
  } catch (error) {
    return { ok: false, state: recommendation, events: [], error: error.message };
  }
}

const GLOBAL_ATTEMPT_TRANSITIONS = deepFreeze({
  admitted: ["dispatched", "failed-closed"],
  dispatched: ["completed", "failed-closed"],
  completed: [],
  "failed-closed": [],
});

export function makeGlobalSynthesisAttempt(data, options = {}) {
  exactKeys(data, GlobalSynthesisAttempt.fields, "GlobalSynthesisAttempt", GlobalSynthesisAttempt.fields.filter((field) => field !== "schemaVersion"));
  const admittedAt = asTimestamp(data.admittedAt);
  const updatedAt = asTimestamp(data.updatedAt);
  if (updatedAt < admittedAt) fail("out-of-order", "attempt update precedes admission");
  const attempt = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    attemptId: asOpaqueRandomId(data.attemptId),
    candidateId: asSha256Hex(data.candidateId),
    supportSetHash: asSha256Hex(data.supportSetHash),
    targetBindingHash: asSha256Hex(data.targetBindingHash),
    state: asEnum(data.state, Object.keys(GLOBAL_ATTEMPT_TRANSITIONS)),
    admittedAt,
    updatedAt,
  });
  assertGlobalIdentitySafe(attempt, options);
  return attempt;
}

export function transitionGlobalSynthesisAttempt(attempt, nextState, now) {
  const current = makeGlobalSynthesisAttempt(attempt);
  const next = asEnum(nextState, Object.keys(GLOBAL_ATTEMPT_TRANSITIONS));
  if (!GLOBAL_ATTEMPT_TRANSITIONS[current.state].includes(next)) fail("invalid-transition", `${current.state}->${next}`);
  const updatedAt = asTimestamp(now);
  if (updatedAt < current.updatedAt) fail("out-of-order", "attempt transition precedes current version");
  return makeGlobalSynthesisAttempt({ ...current, state: next, updatedAt });
}

export function globalTargetLeaseKey(targetBindingOrRootId, relativePath) {
  let rootId;
  let targetPath;
  if (typeof targetBindingOrRootId === "string") {
    rootId = asSha256Hex(targetBindingOrRootId);
    targetPath = asPath(relativePath);
  } else if (targetBindingOrRootId && typeof targetBindingOrRootId === "object"
      && Object.hasOwn(targetBindingOrRootId, "rootId") && Object.hasOwn(targetBindingOrRootId, "relativePath")
      && !Object.hasOwn(targetBindingOrRootId, "bindingHash")) {
    rootId = asSha256Hex(targetBindingOrRootId.rootId);
    targetPath = asPath(targetBindingOrRootId.relativePath);
  } else {
    const target = storedRecommendationTargetBinding(targetBindingOrRootId);
    rootId = target.rootId;
    targetPath = target.relativePath;
  }
  if (targetPath.split("/").length !== 2 || !targetPath.endsWith("/SKILL.md")) fail("target-binding-invalid");
  return sha256(`self-evolve-global-target-lease-v1\n${rootId}\n${targetPath}`);
}

export function makeGlobalLease(data, options = {}) {
  exactKeys(data, GlobalLease.fields, "GlobalLease", GlobalLease.fields.filter((field) => field !== "schemaVersion"));
  const acquiredAt = asTimestamp(data.acquiredAt);
  const expiresAt = asTimestamp(data.expiresAt);
  if (expiresAt <= acquiredAt) fail("out-of-order", "lease must expire after acquisition");
  const state = asEnum(data.state, ["active", "released", "expired"]);
  const releasedAt = data.releasedAt === null ? null : asTimestamp(data.releasedAt);
  if (state === "active" && releasedAt !== null) fail("lease-state-mismatch");
  if (state !== "active" && (releasedAt === null || releasedAt < acquiredAt)) fail("lease-state-mismatch");
  const lease = deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    leaseId: asOpaqueRandomId(data.leaseId),
    leaseKind: asEnum(data.leaseKind, ["candidate-synthesis", "target-write", "global-projection", "global-mailbox"]),
    leaseKeyHash: asSha256Hex(data.leaseKeyHash),
    ownerToken: asOpaqueRandomId(data.ownerToken),
    state,
    acquiredAt,
    expiresAt,
    releasedAt,
  });
  assertGlobalIdentitySafe(lease, options);
  return lease;
}

export function transitionGlobalLease(lease, nextState, now) {
  const current = makeGlobalLease(lease);
  const state = asEnum(nextState, ["released", "expired"]);
  if (current.state !== "active") fail("invalid-transition", `${current.state}->${state}`);
  const releasedAt = asTimestamp(now);
  if (releasedAt < current.acquiredAt) fail("out-of-order");
  if (state === "expired" && releasedAt < current.expiresAt) fail("lease-not-expired");
  return makeGlobalLease({ ...current, state, releasedAt });
}

export function makeProjectAnalysisSettings(data) {
  exactKeys(data, ProjectAnalysisSettings.fields, "ProjectAnalysisSettings", ["projectFingerprint", "override", "updatedAt"]);
  return deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    projectFingerprint: asFingerprint(data.projectFingerprint),
    override: asProjectAnalysisOverride(data.override),
    updatedAt: asTimestamp(data.updatedAt),
  });
}

export function transitionProjectAnalysisSettings(settings, requestedOverride, now) {
  const current = makeProjectAnalysisSettings(settings);
  const override = asProjectAnalysisOverride(requestedOverride);
  const updatedAt = asTimestamp(now);
  if (updatedAt < current.updatedAt) fail("out-of-order", "project analysis transition precedes current version");
  return makeProjectAnalysisSettings({ ...current, override, updatedAt });
}

export function resolveProjectAnalysisMode(defaultMode, projectOverride = "inherit") {
  const fallback = asProjectAnalysisMode(defaultMode);
  const override = asProjectAnalysisOverride(projectOverride);
  return override === "inherit" ? fallback : override;
}

export function resolveConfiguredProjectAnalysisMode(defaultMode, projectOverride = "inherit") {
  const fallback = normalizeLegacyProjectAnalysisMode(defaultMode).mode;
  if (projectOverride === "inherit") return fallback;
  return normalizeLegacyProjectAnalysisMode(projectOverride).mode;
}

export function resolveProjectOperationalState(data) {
  const fields = ["configuredMode", "bootValidated", "paused", "killSwitchActive", "excluded", "corrupt", "circuitBreakerOpen", "hostSupported"];
  exactKeys(data, fields, "ProjectOperationalState");
  const configuredMode = asProjectAnalysisMode(data.configuredMode);
  const gates = Object.fromEntries(fields.slice(1).map((field) => [field, asBoolean(data[field], field)]));
  let reason = null;
  if (!gates.hostSupported) reason = "host-unsupported";
  else if (!gates.bootValidated) reason = "boot-not-validated";
  else if (gates.corrupt) reason = "corrupt-state";
  else if (gates.killSwitchActive) reason = "kill-switch";
  else if (gates.paused) reason = "paused";
  else if (gates.excluded) reason = "excluded";
  else if (gates.circuitBreakerOpen) reason = "circuit-breaker";
  else if (configuredMode === "manual") reason = "manual";
  return deepFreeze({ configuredMode, passiveAnalysisAllowed: reason === null, reason });
}

export function evaluateGlobalWriteAuthority(data) {
  const fields = ["action", "explicitDecision", "grantFresh", "targetBound", "supportValid", "consentCurrent", "rootValidated", "killSwitchActive", "criticPassed", "deterministicValid"];
  exactKeys(data, fields, "GlobalWriteAuthority");
  asEnum(data.action, ["apply", "undo"]);
  const values = Object.fromEntries(fields.slice(1).map((field) => [field, asBoolean(data[field], field)]));
  if (values.killSwitchActive) return deepFreeze({ allowed: false, reason: "kill-switch" });
  if (!values.explicitDecision) return deepFreeze({ allowed: false, reason: "explicit-decision-required" });
  if (!values.grantFresh) return deepFreeze({ allowed: false, reason: "stale-grant" });
  if (!values.targetBound) return deepFreeze({ allowed: false, reason: "target-binding-invalid" });
  if (!values.supportValid) return deepFreeze({ allowed: false, reason: "support-invalid" });
  if (!values.consentCurrent) return deepFreeze({ allowed: false, reason: "consent-revoked" });
  if (!values.rootValidated) return deepFreeze({ allowed: false, reason: "root-not-validated" });
  if (!values.criticPassed) return deepFreeze({ allowed: false, reason: "critic-gate-failed" });
  if (!values.deterministicValid) return deepFreeze({ allowed: false, reason: "deterministic-gate-failed" });
  return deepFreeze({ allowed: true, reason: "explicit-global-write" });
}

export function makeV3RetentionPolicy(data = {}) {
  exactKeys(data, V3RetentionPolicy.fields, "V3RetentionPolicy", []);
  const day = (field) => asInt(data[field] ?? V3_RETENTION_DEFAULTS[field], { min: 1, max: 3650 });
  return deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    projectEvidenceDays: day("projectEvidenceDays"),
    evidenceCapsuleDays: day("evidenceCapsuleDays"),
    globalContributionDays: day("globalContributionDays"),
    globalCandidateDays: day("globalCandidateDays"),
    globalRecommendationDays: day("globalRecommendationDays"),
    globalAuditDays: day("globalAuditDays"),
    bridgeArtifactHours: asInt(data.bridgeArtifactHours ?? V3_RETENTION_DEFAULTS.bridgeArtifactHours, { min: 1, max: 24 * 30 }),
    actingMetadataTtlMs: asInt(data.actingMetadataTtlMs ?? V3_RETENTION_DEFAULTS.actingMetadataTtlMs, { min: 1, max: 60_000 }),
    leaseMaxTtlMs: asInt(data.leaseMaxTtlMs ?? V3_RETENTION_DEFAULTS.leaseMaxTtlMs, { min: 1, max: 3_600_000 }),
  });
}

function globalProtocolVersion(value) {
  return asInt(value ?? V3_PROTOCOL_CONTRACT.globalOperationVersion, {
    min: V3_PROTOCOL_CONTRACT.globalOperationVersion,
    max: V3_PROTOCOL_CONTRACT.globalOperationVersion,
  });
}

export function makeGlobalActionRequest(data) {
  exactKeys(data, GlobalActionRequest.fields, "GlobalActionRequest", GlobalActionRequest.fields.filter((field) => !["protocolVersion", "requestHash"].includes(field)));
  const issuedAt = asTimestamp(data.issuedAt);
  const expiresAt = asTimestamp(data.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > V3_RETENTION_DEFAULTS.actingMetadataTtlMs) fail("out-of-order", "global action request expiry is invalid");
  const body = {
    protocolVersion: globalProtocolVersion(data.protocolVersion),
    capability: asEnum(data.capability, ["global-action-request-v1"]),
    requestId: asOpaqueRandomId(data.requestId),
    stateRootIdentity: asSha256Hex(data.stateRootIdentity),
    actingProjectFingerprint: asFingerprint(data.actingProjectFingerprint),
    actingHealthHash: asSha256Hex(data.actingHealthHash),
    projectionGenerationHash: asSha256Hex(data.projectionGenerationHash),
    indexHash: asSha256Hex(data.indexHash),
    detailHash: asSha256Hex(data.detailHash),
    grantHash: asSha256Hex(data.grantHash),
    recommendationId: asSha256Hex(data.recommendationId),
    recommendationVersion: asInt(data.recommendationVersion, { min: 1, max: 1_000_000 }),
    supportSetHash: asSha256Hex(data.supportSetHash),
    targetBindingHash: asSha256Hex(data.targetBindingHash),
    targetHash: data.targetHash === "must-not-exist" ? data.targetHash : asSha256Hex(data.targetHash),
    proposedContentHash: asSha256Hex(data.proposedContentHash),
    priorState: asEnum(data.priorState, GLOBAL_RECOMMENDATION_STATES),
    action: asEnum(data.action, ["apply", "reject", "undo"]),
    actorRole: asEnum(data.actorRole, ["operator"]),
    issuedAt,
    expiresAt,
    nonce: nonceString(data.nonce),
  };
  const expectedPriorState = body.action === "undo" ? "applied" : "pending";
  if (body.priorState !== expectedPriorState) fail("action-request-prior-state-mismatch");
  const requestHash = sha256(`self-evolve-global-action-request-v1\n${canonicalize(body)}`);
  if (data.requestHash !== undefined && asSha256Hex(data.requestHash) !== requestHash) fail("action-request-hash-mismatch");
  return deepFreeze({ ...body, requestHash });
}

export function makeGlobalConsumerClaim(data) {
  exactKeys(data, GlobalConsumerClaim.fields, "GlobalConsumerClaim", GlobalConsumerClaim.fields.filter((field) => field !== "protocolVersion"));
  const acquiredAt = asTimestamp(data.acquiredAt);
  const expiresAt = asTimestamp(data.expiresAt);
  if (expiresAt <= acquiredAt || expiresAt - acquiredAt > V3_RETENTION_DEFAULTS.actingMetadataTtlMs) fail("out-of-order", "consumer claim expiry is invalid");
  const state = asEnum(data.state, ["active", "released", "expired"]);
  const releasedAt = data.releasedAt === null ? null : asTimestamp(data.releasedAt);
  if (state === "active" && releasedAt !== null) fail("consumer-claim-state-mismatch");
  if (state !== "active" && releasedAt === null) fail("consumer-claim-state-mismatch");
  return deepFreeze({
    protocolVersion: globalProtocolVersion(data.protocolVersion),
    claimId: asOpaqueRandomId(data.claimId),
    requestId: asOpaqueRandomId(data.requestId),
    consumerInstanceId: asOpaqueRandomId(data.consumerInstanceId),
    consumerProjectFingerprint: asFingerprint(data.consumerProjectFingerprint),
    state,
    acquiredAt,
    expiresAt,
    releasedAt,
  });
}

export function validateGlobalActionAuthority(request, consumerClaim, context) {
  const action = makeGlobalActionRequest(request);
  const consumer = makeGlobalConsumerClaim(consumerClaim);
  const fields = ["now", "consumerBootValidated", "stateRootIdentity", "actingProjectFingerprint", "actingHealthHash", "projectionGenerationHash", "indexHash", "detailHash", "grantHash", "recommendationId", "recommendationVersion", "supportSetHash", "targetBindingHash", "targetHash", "proposedContentHash", "priorState", "action"];
  exactKeys(context, fields, "GlobalActionAuthority");
  const now = asTimestamp(context.now);
  if (!asBoolean(context.consumerBootValidated, "consumerBootValidated")) fail("consumer-boot-not-validated");
  if (action.expiresAt <= now) fail("expired-action-request");
  if (consumer.state !== "active" || consumer.acquiredAt > now || consumer.expiresAt <= now) fail("inactive-consumer-claim");
  if (consumer.requestId !== action.requestId) fail("consumer-request-mismatch");
  const expected = {
    stateRootIdentity: asSha256Hex(context.stateRootIdentity),
    actingProjectFingerprint: asFingerprint(context.actingProjectFingerprint),
    actingHealthHash: asSha256Hex(context.actingHealthHash),
    projectionGenerationHash: asSha256Hex(context.projectionGenerationHash),
    indexHash: asSha256Hex(context.indexHash),
    detailHash: asSha256Hex(context.detailHash),
    grantHash: asSha256Hex(context.grantHash),
    recommendationId: asSha256Hex(context.recommendationId),
    recommendationVersion: asInt(context.recommendationVersion, { min: 1, max: 1_000_000 }),
    supportSetHash: asSha256Hex(context.supportSetHash),
    targetBindingHash: asSha256Hex(context.targetBindingHash),
    targetHash: context.targetHash === "must-not-exist" ? context.targetHash : asSha256Hex(context.targetHash),
    proposedContentHash: asSha256Hex(context.proposedContentHash),
    priorState: asEnum(context.priorState, GLOBAL_RECOMMENDATION_STATES),
    action: asEnum(context.action, ["apply", "reject", "undo"]),
  };
  for (const [key, value] of Object.entries(expected)) if (action[key] !== value) fail("stale-action-authority", key);
  return true;
}

export function makeGlobalAuditEvent(data, options = {}) {
  exactKeys(data, GlobalAuditEvent.fields, "GlobalAuditEvent", GlobalAuditEvent.fields.filter((field) => !["schemaVersion", "auditId"].includes(field)));
  const body = {
    kind: asEnum(data.kind, ["decision", "apply", "undo", "reject", "supersede", "failure", "purge", "support-invalidated"]),
    recommendationId: data.recommendationId === null ? null : asSha256Hex(data.recommendationId),
    actorRole: asEnum(data.actorRole, ["operator", "critic", "applier", "policy"]),
    timestamp: asTimestamp(data.timestamp),
    supportSetHash: data.supportSetHash === null ? null : asSha256Hex(data.supportSetHash),
    targetBindingHash: data.targetBindingHash === null ? null : asSha256Hex(data.targetBindingHash),
    proposedContentHash: data.proposedContentHash === null ? null : asSha256Hex(data.proposedContentHash),
    decisionVersion: asInt(data.decisionVersion, { min: 0, max: 1_000_000 }),
    outcome: asEnum(data.outcome, ["succeeded", "rejected", "failed-closed", "accepted-terminal"]),
  };
  const auditId = sha256(`self-evolve-global-audit-v1\n${canonicalize(body)}`);
  if (data.auditId !== undefined && asSha256Hex(data.auditId) !== auditId) fail("global-audit-id-mismatch");
  const audit = deepFreeze({ schemaVersion: v3SchemaVersion(data.schemaVersion), auditId, ...body });
  assertGlobalIdentitySafe(audit, options);
  return audit;
}

const V3_PURGE_STATES = Object.freeze(["requested", "accepted", "authority-stopped", "deleting", "completed", "failed-closed"]);

export function makeV3PurgeOperation(data) {
  exactKeys(data, V3PurgeOperation.fields, "V3PurgeOperation", V3PurgeOperation.fields.filter((field) => field !== "schemaVersion"));
  const scope = asEnum(data.scope, ["project-evidence", "project", "global-recommendation", "global-recommendations", "all"]);
  const recommendationId = data.recommendationId === null ? null : asSha256Hex(data.recommendationId);
  if ((scope === "global-recommendation") !== (recommendationId !== null)) fail("purge-scope-mismatch");
  const confirmation = data.confirmation === null ? null : asNonEmptyString(data.confirmation, { max: 128 });
  if (scope === "all" && confirmation !== "PURGE ALL SELF-EVOLVE 0.3.0") fail("purge-confirmation-mismatch");
  if (scope !== "all" && confirmation !== null) fail("purge-confirmation-mismatch");
  const requestedAt = asTimestamp(data.requestedAt);
  const updatedAt = asTimestamp(data.updatedAt);
  if (updatedAt < requestedAt) fail("out-of-order", "purge update precedes request");
  return deepFreeze({
    schemaVersion: v3SchemaVersion(data.schemaVersion),
    operationId: asOpaqueRandomId(data.operationId),
    scope,
    actingProjectFingerprint: asFingerprint(data.actingProjectFingerprint),
    recommendationId,
    state: asEnum(data.state, V3_PURGE_STATES),
    actorRole: asEnum(data.actorRole, ["operator"]),
    requestedAt,
    updatedAt,
    nonce: nonceString(data.nonce),
    confirmation,
  });
}

export function transitionV3PurgeOperation(operation, nextState, now) {
  const current = makeV3PurgeOperation(operation);
  const state = asEnum(nextState, V3_PURGE_STATES);
  const transitions = current.scope === "all"
    ? {
        requested: ["accepted", "failed-closed"],
        accepted: ["authority-stopped", "failed-closed"],
        "authority-stopped": ["deleting", "failed-closed"],
        deleting: ["completed", "failed-closed"],
        completed: [],
        "failed-closed": [],
      }
    : {
        requested: ["accepted", "failed-closed"],
        accepted: ["deleting", "failed-closed"],
        "authority-stopped": [],
        deleting: ["completed", "failed-closed"],
        completed: [],
        "failed-closed": [],
      };
  if (!transitions[current.state].includes(state)) fail("invalid-transition", `${current.state}->${state}`);
  const updatedAt = asTimestamp(now);
  if (updatedAt < current.updatedAt) fail("out-of-order");
  return makeV3PurgeOperation({ ...current, state, updatedAt });
}

export function evaluateV3ConsentTransition(previous, next) {
  const before = makeConsentState(previous);
  const after = makeConsentState(next);
  const deleteProjectCapsules = before.sanitizedExcerpts && !after.sanitizedExcerpts;
  const aggregationRevoked = (before.crossRepoAggregation && !after.crossRepoAggregation) || deleteProjectCapsules;
  const durableRevoked = before.durableObservations && !after.durableObservations;
  return deepFreeze({
    stopPassiveAnalysis: before.passiveCalls && !after.passiveCalls,
    stopDurableObservation: durableRevoked,
    deleteProjectCapsules,
    stopGlobalContributions: aggregationRevoked || durableRevoked,
    invalidateGlobalSupport: aggregationRevoked || durableRevoked,
    blockGlobalApply: aggregationRevoked || durableRevoked,
  });
}

export function resolveMode(globalMode, repoMode = "inherit", overrides = {}) {
  try {
    exactKeys(overrides, ["killSwitchActive", "paused", "circuitBreakerOpen", "processExcluded", "repoOptOut", "hostSupported", "corrupt"], "mode overrides", []);
    const global = asMode(globalMode ?? "manual");
    const repo = asRepoMode(repoMode ?? "inherit");
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

const STRUCTURED_SECRET_RE = /(?:-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:sk-(?:ant-api03-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dop_v1_[A-Fa-f0-9]{32,})\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/iu;

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
    const mode = scope === "repo" ? asRepoMode(request.mode) : asMode(request.mode);
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
    // v0.3 has no unattended apply authority in any mode.
    const state = deepFreeze({ global: nextGlobal, repo: nextRepo, effectiveMode, unattendedApplyAllowed: false });
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
  // v0.3 narrows the legacy `yolo` input to `auto`, so every remaining legacy
  // project apply needs an approved scope plus the same explicit decision, in
  // every mode. No mode can substitute scope or release evidence for it.
  if (!allowlisted) return deepFreeze({ allowed: false, reason: "scope-not-allowlisted" });
  return deepFreeze({ allowed: decisionApproved, reason: decisionApproved ? "explicit-decision" : "decision-required" });
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
