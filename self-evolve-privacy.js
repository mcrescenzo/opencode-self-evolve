import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { isActiveProposalChainRecord, isActiveProposalState } from "./self-evolve-store.js";
import { containsPrivateMaterial } from "./self-evolve-projection.js";
import {
  V4ConsentState,
  Observation,
  errorReasonCode,
  evaluateContributionConsentAuthority,
  makeAuditEvent,
  makeEvidenceCapsule,
  makeObservation,
  makeRepoSettings,
  makeV4ConsentState,
  wrapRecord,
} from "./self-evolve-schemas.js";

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_EXCERPT_LENGTH = 240;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const CONTROL_GLOBAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const ABSOLUTE_PATH = /(?:^|[\s"'(])(?:\/(?![\/*])[^\s"'()<>]+|[A-Za-z]:\\[^\s"'()<>]+)/u;
const ABSOLUTE_PATH_GLOBAL = /(?:^|[\s"'(])(?:\/(?![\/*])[^\s"'()<>]+|[A-Za-z]:\\[^\s"'()<>]+)/gu;
const PROVIDER_TOKEN_PATTERNS = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:sk-(?:ant-api03-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/gi,
  /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/gi,
  /\b(?:xox[a-z]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/gi,
  /\b(?:npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dop_v1_[A-Fa-f0-9]{32,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*["']?[^"'\s,;]{8,}/gi,
];
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/g;
const PRIVATE_KEY_MARKER = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u;
const JAVASCRIPT_LINK_RE = new RegExp(
  "(?:"
    + "(?:!?\\]\\(\\s*|<[^>]*\\b(?:href|src)\\s*=\\s*[\"']?\\s*)javascript:"
    + "|"
    + "(?:^|[\\s\"'`=(])javascript:[ \\t]*\\S{2,}"
  + ")",
  "iu",
);
const DATA_LINK_RE = new RegExp(
  "(?:"
    + "(?:!?\\]\\(\\s*|<[^>]*\\b(?:href|src)\\s*=\\s*[\"']?\\s*)data:"
    + "|"
    + "(?:^|[\\s\"'`=(])data:[^\\s\"'()<>]{2,}"
  + ")",
  "iu",
);
const NEVER_STORED_KEY = /(?:^|_)(?:content|body|messageBody|rawMessage|rawText|transcript|completeTranscript)(?:$|_)/iu;
const REPO_NAME_KEY = /(?:project|repo(?:sitory)?|customer)(?:Name|Id|Identifier)?$/iu;
const UNIQUE_COMMAND_KEY = /(?:command|commandName|uniqueCommand|rawCommand)$/iu;
const CAPSULE_SELF_REFERENCE_RE = /(?:\/self-evolve|\bself-evolve\b|proposal\s+from\s+self-evolve)/iu;
const PRIVATE_NAME_CANARY_RE = /\b(?:customer|client|tenant|repository|repo|project|private)[-_:\s]+[a-z0-9][a-z0-9._-]{2,}\b/iu;
const REMOTE_URL_GLOBAL = /\b(?:git|ssh|https?|ftp):\/\/[^\s"'<>]+|\bgit@[^\s@"':]+:[^\s"'<>]+/gu;
const PRIVATE_NAME_GLOBAL = /\b(?:customer|client|tenant|repository|repo|project|private)[-_:\s]+[a-z0-9][a-z0-9._-]{2,}\b/giu;
const CONTRIBUTION_INPUT_FIELDS = Object.freeze([
  "claimType", "receiptType", "signatureHash", "incidentId", "capsuleId", "clusterId",
  "evidenceDomainId", "occurrenceCount", "firstSeenAt", "lastSeenAt",
]);

function normalizeAutomationConsent(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return makeV4ConsentState(Object.fromEntries(
    V4ConsentState.fields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  ));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recordPayload(record) {
  return record?.payload && typeof record.payload === "object" ? record.payload : record;
}

function recordFingerprint(record) {
  return recordPayload(record)?.projectFingerprint;
}

function requestedFingerprint(scope) {
  return typeof scope === "string" ? scope : scope?.projectFingerprint;
}

function timestampFor(record) {
  const payload = recordPayload(record) ?? {};
  return {
    "episode-cursor": payload.lastIdleAt,
    receipt: payload.lastSeenAt,
    observation: payload.createdAt,
    "evidence-cluster": payload.lastSeenAt,
    "eligibility-explanation": record?.createdAt,
    proposal: payload.synthesizedAt,
    decision: payload.timestamp,
    "audit-event": payload.timestamp,
    "rollback-record": payload.rolledBackAt,
    "intervention-epoch": payload.startedAt,
    "circuit-breaker": payload.openedAt ?? record?.createdAt,
  }[record?.kind] ?? payload.createdAt ?? payload.synthesizedAt ?? payload.timestamp ?? record?.createdAt;
}

function logicalId(record) {
  const payload = recordPayload(record) ?? {};
  return payload.id ?? payload.proposalId ?? record?.id;
}

function walk(value, visit, key = "") {
  visit(value, key);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit, key));
    return;
  }
  for (const [childKey, child] of Object.entries(value)) walk(child, visit, childKey);
}

function issueScan(text, blockedNames = []) {
  const source = String(text);
  const issues = new Set();
  if (source.includes("\0")) issues.add("nul-byte");
  if (CONTROL.test(source)) issues.add("control-characters");
  if (PROVIDER_TOKEN_PATTERNS.some((pattern) => { pattern.lastIndex = 0; return pattern.test(source); })) issues.add("provider-token");
  if (PRIVATE_KEY_MARKER.test(source)) issues.add("private-key");
  if (JAVASCRIPT_LINK_RE.test(source)) issues.add("javascript-link");
  if (DATA_LINK_RE.test(source)) issues.add("data-link");
  if (/```|~~~/u.test(source)) issues.add("code-block");
  if (PRIVATE_NAME_CANARY_RE.test(source)) issues.add("private-name");
  if (/\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system)\s+instructions?\b/iu.test(source)) issues.add("prompt-injection-marker");
  if (/\b(?:system\s*:\s*you must now apply|you must now apply|you are now in (?:auto|yolo) mode|you are (?:now )?authorized|grant (?:me|yourself) (?:full |elevated )?(?:authority|permissions?)|bypass (?:the )?(?:approval|permission|authority)|ignore (?:the )?(?:approval|permission) (?:gate|rules?))\b/iu.test(source)) issues.add("authority-escalation");
  if (ABSOLUTE_PATH.test(source)) issues.add("absolute-path");
  for (const name of blockedNames) {
    if (name && new RegExp(`(?:^|\\W)${escapeRegex(name)}(?:$|\\W)`, "iu").test(source)) issues.add("blocked-repository-identifier");
  }
  return [...issues];
}

/**
 * Centralized diagnostic-scrubbing predicate for a single string. Replaces
 * provider tokens, private keys, remote URLs, absolute paths, private-name
 * canaries, and control characters with fixed placeholders. Returns heuristic
 * redaction only; "redacted" is not a secrecy guarantee. Used to keep scrubbed
 * diagnostics ephemeral across audits, exports, and response text so raw host
 * errors never echo tokens, paths, private names, or message contents.
 */
export function redactPrivateMaterial(text) {
  if (typeof text !== "string") return text;
  let redacted = text.replace(/```[\s\S]*?```/g, "<code>").replace(PRIVATE_KEY, "<private-key>");
  for (const pattern of PROVIDER_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "<token>");
  }
  redacted = redacted.replace(REMOTE_URL_GLOBAL, "<remote>");
  redacted = redacted.replace(ABSOLUTE_PATH_GLOBAL, (match) => `${/^\s/u.test(match) ? match[0] : ""}<path>`);
  redacted = redacted.replace(PRIVATE_NAME_GLOBAL, "<private-name>");
  redacted = redacted.replace(CONTROL_GLOBAL, "");
  return redacted;
}

const REDACT_SKIP_KEYS = new Set(["content"]);
const REDACT_BLANK_KEYS = NEVER_STORED_KEY;

/** Returns a structurally identical copy with every string value redacted. */
export function redactRecordPrivateMaterial(record) {
  const redact = (value, key) => {
    if (typeof value === "string") {
      // Message bodies, transcripts, and raw-text fields are blanked by field
      // name: their contents are never appropriate for audits or exports even
      // when no content pattern matches.
      if (REDACT_BLANK_KEYS.test(key)) return null;
      return redactPrivateMaterial(value);
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, key));
    if (value && typeof value === "object") {
      const out = {};
      for (const [childKey, child] of Object.entries(value)) out[childKey] = REDACT_SKIP_KEYS.has(childKey) ? child : redact(child, childKey);
      return out;
    }
    return value;
  };
  return redact(record, "");
}

function expirationFor(record, retentionDays) {
  const createdAt = timestampFor(record);
  if (!Number.isSafeInteger(createdAt)) return null;
  const payload = recordPayload(record) ?? {};
  const kind = record?.kind ?? (payload.synthesizedAt !== undefined
    ? "proposal"
    : payload.timestamp !== undefined
      ? "decision"
      : payload.createdAt !== undefined
        ? "observation"
        : null);
  if (["episode-cursor", "receipt", "observation", "evidence-cluster", "eligibility-explanation"].includes(kind)) return observationExpiresAt(createdAt, retentionDays);
  if (["proposal", "proposal-content", "synthesis-attempt", "decision", "audit-event", "rollback-record", "intervention-epoch", "circuit-breaker"].includes(kind)) return proposalExpiresAt(createdAt, retentionDays);
  if (kind === "apply-claim") return Number.isSafeInteger(payload.expiresAt) ? payload.expiresAt : null;
  return null;
}

function requireStore(store) {
  if (!store || typeof store.exportAll !== "function") throw new TypeError("privacy-store-required");
  return store;
}

export function observationExpiresAt(createdAt, retentionDays = DEFAULT_RETENTION_DAYS) {
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new TypeError("invalid-retention");
  return createdAt + retentionDays * DAY_MS;
}

export function proposalExpiresAt(createdAt, retentionDays = DEFAULT_RETENTION_DAYS) {
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new TypeError("invalid-retention");
  return createdAt + retentionDays * 3 * DAY_MS;
}

export function isExpired(timestamp, nowMs) {
  return Number.isSafeInteger(timestamp) && Number.isSafeInteger(nowMs) && timestamp <= nowMs;
}

export function assertSafeGlobalClaim(record, { allowRepoIdentifiers = false, blockedNames = [] } = {}) {
  if (allowRepoIdentifiers) return { ok: true };
  let reason = null;
  walk(record, (value, key) => {
    if (reason) return;
    if (REPO_NAME_KEY.test(key) || UNIQUE_COMMAND_KEY.test(key)) reason = "repository-identifier";
    else if (typeof value === "string") {
      const issues = issueScan(value, blockedNames);
      if (issues.includes("absolute-path") || issues.includes("blocked-repository-identifier")) reason = "repository-identifier";
    }
  });
  return reason ? { ok: false, reason } : { ok: true };
}

export function createPrivacyGuard({
  consent,
  projectFingerprint,
  retentionDays = DEFAULT_RETENTION_DAYS,
  storageQuotaMiB = 8,
  now = () => Date.now(),
  store,
  blockedNames = [],
} = {}) {
  const hasExplicitConsent = consent !== undefined;
  // The caller may still pass the retained v0.3 settings view. Consume only
  // the three v0.4 permission bits; retired passive-call consent has no role.
  const initialConsent = normalizeAutomationConsent(consent ?? V4ConsentState.defaults);
  if (!FINGERPRINT.test(String(projectFingerprint))) throw new TypeError("invalid-project-fingerprint");
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new TypeError("invalid-retention");
  if (!Number.isFinite(storageQuotaMiB) || storageQuotaMiB < 0) throw new TypeError("invalid-storage-quota");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (!Array.isArray(blockedNames) || blockedNames.some((name) => typeof name !== "string")) throw new TypeError("invalid-blocklist");
  const invalidated = new Set();
  const quotaBytes = Math.floor(storageQuotaMiB * 1024 * 1024);

  function durableSettings() {
    if (!store?.getSettings) return { global: { consent: initialConsent, retentionDays, budgets: { storageQuotaMiB } } };
    return store.getSettings();
  }

  function freshConsent() {
    if (hasExplicitConsent) return initialConsent;
    try {
      const automation = store?.getAutomationState?.();
      if (automation) {
        if (!automation.ok || !automation.enabled) throw new Error("automatic-recommendations-disabled");
        return normalizeAutomationConsent(automation.global.consent);
      }
      return initialConsent;
    }
    catch { return makeV4ConsentState({ durableObservations: false, sanitizedExcerpts: false, crossRepoAggregation: false }); }
  }

  function freshRetentionDays() {
    const current = store?.getSettings ? durableSettings().global.retentionDays : retentionDays;
    if (!Number.isSafeInteger(current) || current < 1) throw new TypeError("invalid-retention");
    return current;
  }

  function successfulObservation(sanitized) {
    const result = { ...sanitized };
    Object.defineProperties(result, {
      ok: { value: true },
      sanitized: { value: result },
      observation: { value: result },
    });
    return result;
  }

  function scanForForbiddenContent(text) {
    const issues = issueScan(text, blockedNames);
    return { ok: issues.length === 0, issues };
  }

  function scrubObservationForProject(observation, expectedProjectFingerprint) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return { ok: false, reason: "invalid-observation" };
    if (!observation.projectFingerprint) return { ok: false, reason: "project-fingerprint-required" };
    if (observation.projectFingerprint !== expectedProjectFingerprint) return { ok: false, reason: "project-partition-mismatch" };
    const globalScope = observation.scope === "global" || observation.structuredFields?.scope === "global";
    let rejected = null;
    walk(observation, (value, key) => {
      if (rejected) return;
      if (NEVER_STORED_KEY.test(key)) rejected = "raw-message-content-forbidden";
      else if (typeof value === "string") {
        const scan = scanForForbiddenContent(value);
        if (scan.issues.includes("control-characters") || scan.issues.includes("nul-byte")) rejected = "control-characters";
        else if (scan.issues.includes("provider-token") || scan.issues.includes("private-key")) rejected = "secret-marker";
        else if (scan.issues.length > 0
          && !(globalScope && scan.issues.every((issue) => issue === "absolute-path" || issue === "blocked-repository-identifier"))) {
          rejected = "unsafe-content";
        }
      }
    });
    if (rejected) return { ok: false, reason: rejected };
    if (globalScope) {
      const consentNow = freshConsent();
      const global = assertSafeGlobalClaim(observation, { blockedNames });
      if (!global.ok || !consentNow.sanitizedExcerpts || !consentNow.crossRepoAggregation) {
        return { ok: false, reason: global.reason ?? (!consentNow.sanitizedExcerpts ? "sanitized-excerpts-consent-required" : "cross-repo-consent-required") };
      }
    }
    try {
      const sanitized = makeObservation(Object.fromEntries(Observation.fields.map((key) => [key, observation[key]])));
      return successfulObservation(sanitized);
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "privacy-failed") };
    }
  }

  function automationConsent(automationStamp) {
    if (!automationStamp && hasExplicitConsent) return initialConsent;
    const state = store?.getAutomationState?.();
    if (!state) return initialConsent;
    if (!state.ok || !state.enabled
      || (automationStamp && !store.compareAutomationStamp?.(automationStamp))) {
      return { durableObservations: false, sanitizedExcerpts: false, crossRepoAggregation: false };
    }
    return state.global.consent;
  }

  function resolvedAutomationStamp(automationStamp) {
    if (automationStamp) return automationStamp;
    const state = store?.getAutomationState?.();
    return state?.ok && state.enabled ? state.stamp : null;
  }

  function scrubObservation(observation, { automationStamp = null } = {}) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return { ok: false, reason: "invalid-observation" };
    if (!observation.projectFingerprint) return { ok: false, reason: "project-fingerprint-required" };
    if (observation.projectFingerprint !== projectFingerprint) return { ok: false, reason: "project-partition-mismatch" };
    if (!automationConsent(automationStamp).durableObservations) return { ok: false, reason: "observation-consent-required" };
    return scrubObservationForProject(observation, projectFingerprint);
  }

  function scrubExportRecords(records, expectedProjectFingerprint) {
    const privateProposalIds = new Set(records.flatMap((record) => {
      if (record.kind !== "proposal-content") return [];
      let content;
      try { content = Buffer.from(record.payload.content, "base64").toString("utf8"); }
      catch { return [record.payload.proposalId]; }
      return containsPrivateMaterial(content) ? [record.payload.proposalId] : [];
    }));
    return records.flatMap((record) => {
      if (record.kind === "proposal-content" && privateProposalIds.has(record.payload.proposalId)) return [];
      if (record.kind === "observation") {
        const result = scrubObservationForProject(record.payload, expectedProjectFingerprint);
        if (!result.ok) throw new Error(`unsafe-observation:${result.reason}`);
        return [{ ...record, payload: result.sanitized }];
      }
      // H6-002: redact every remaining record kind so raw host errors that
      // reached an audit detail, decision reason, or rollback reason never
      // surface tokens, paths, private names, or message contents in exports.
      return [redactRecordPrivateMaterial(record)];
    });
  }

  /** Returns heuristic redaction only; "redacted" is not a secrecy guarantee. */
  function scrubExcerpt({ text, maxLength = DEFAULT_EXCERPT_LENGTH } = {}, { automationStamp = null } = {}) {
    if (!automationConsent(automationStamp).sanitizedExcerpts) return { ok: false, reason: "sanitized-excerpts-consent-required" };
    if (typeof text !== "string" || !Number.isSafeInteger(maxLength) || maxLength < 0) return { ok: false, reason: "invalid-excerpt" };
    let redacted = text.replace(/```[\s\S]*?```/g, "<code>").replace(PRIVATE_KEY, "<private-key>");
    for (const pattern of PROVIDER_TOKEN_PATTERNS) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, "<token>");
    }
    redacted = redacted.replace(ABSOLUTE_PATH_GLOBAL, (match) => `${/^\s/u.test(match) ? match[0] : ""}<path>`);
    redacted = redacted.replace(CONTROL_GLOBAL, "").slice(0, maxLength);
    return { ok: true, redacted, hash: sha256(redacted), length: redacted.length };
  }

  function createEvidenceCapsule(input, { automationStamp = null } = {}) {
    const consent = automationConsent(automationStamp);
    if (!consent.durableObservations) return { ok: false, reason: "observation-consent-required" };
    if (!consent.sanitizedExcerpts) return { ok: false, reason: "sanitized-excerpts-consent-required" };
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "invalid-capsule-input" };
    const allowed = ["incidentId", "receiptType", "targetLogicalName", "summary"];
    if (Object.keys(input).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in input))) {
      return { ok: false, reason: "invalid-capsule-input" };
    }
    const issues = issueScan(input.summary, blockedNames);
    if (issues.length || CAPSULE_SELF_REFERENCE_RE.test(String(input.summary))) {
      return { ok: false, reason: "capsule-summary-rejected" };
    }
    try {
      const createdAt = now();
      const capsule = makeEvidenceCapsule({
        capsuleId: randomUUID(),
        incidentId: input.incidentId,
        receiptType: input.receiptType,
        targetLogicalName: input.targetLogicalName,
        summary: input.summary,
        createdAt,
        expiresAt: observationExpiresAt(createdAt, freshRetentionDays()),
      });
      return requireStore(store).appendEvidenceCapsule(capsule, { automationStamp: resolvedAutomationStamp(automationStamp) });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "capsule-rejected") };
    }
  }

  function getEvidenceCapsuleSupport(incidentId, { automationStamp = null } = {}) {
    try { return requireStore(store).getEvidenceCapsuleSupport(incidentId, { nowMs: now(), automationStamp: resolvedAutomationStamp(automationStamp) }); }
    catch (error) { return { available: false, reason: errorReasonCode(error, "evidence-capsule-unavailable") }; }
  }

  function checkPartition(record, requestedScope) {
    const expected = requestedFingerprint(requestedScope);
    const actual = recordFingerprint(record);
    if (!FINGERPRINT.test(String(expected)) || actual !== expected) return { ok: false, allowedScope: null };
    return { ok: true, allowedScope: requestedScope };
  }

  function checkGlobalAggregation(records, requestedScope) {
    const consentNow = freshConsent();
    if (!consentNow.sanitizedExcerpts) return { ok: false, reason: "sanitized-excerpts-consent-required", sanitized: [] };
    if (!consentNow.crossRepoAggregation) return { ok: false, reason: "cross-repo-consent-required", sanitized: [] };
    if (requestedScope?.scope !== undefined && requestedScope.scope !== "global") return { ok: false, reason: "global-scope-required", sanitized: [] };
    const claims = new Map();
    for (const record of records) {
      const safe = assertSafeGlobalClaim(record, { blockedNames });
      if (!safe.ok) return { ok: false, reason: safe.reason, sanitized: [] };
      const payload = recordPayload(record) ?? {};
      const fields = payload.structuredFields ?? payload;
      const signature = fields.commandSignatureHash ?? fields.signatureHash ?? payload.signatureHash ?? fields.procedureFingerprint;
      if (!FINGERPRINT.test(String(signature))) return { ok: false, reason: "normalized-signature-required", sanitized: [] };
      const occurrences = Number.isSafeInteger(fields.occurrences) && fields.occurrences > 0 ? fields.occurrences : 1;
      claims.set(signature, (claims.get(signature) ?? 0) + occurrences);
    }
    return { ok: true, sanitized: [...claims].sort(([a], [b]) => a.localeCompare(b)).map(([signature, occurrences]) => ({ signature, occurrences })) };
  }

  function publishContribution(input, { automationStamp = null } = {}) {
    // H6-001: the privacy guard reuses the unified three-bit contribution
    // authority predicate so creation and recovery enforce the identical gate.
    const authority = evaluateContributionConsentAuthority(automationConsent(automationStamp));
    if (!authority.ok) return { ok: false, reason: authority.reason };
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "invalid-contribution-input" };
    const keys = Object.keys(input);
    if (keys.some((key) => !CONTRIBUTION_INPUT_FIELDS.includes(key))
        || CONTRIBUTION_INPUT_FIELDS.some((key) => !(key in input))) {
      return { ok: false, reason: "invalid-contribution-input" };
    }
    try { return requireStore(store).publishContribution(input, { automationStamp: resolvedAutomationStamp(automationStamp) }); }
    catch (error) { return { ok: false, reason: errorReasonCode(error, "privacy-failed") }; }
  }

  function checkRetention(nowMs = now()) {
    const currentRetentionDays = freshRetentionDays();
    const archive = requireStore(store).exportProject();
    const latest = new Map();
    for (const record of archive.records) if (record.kind === "proposal") latest.set(record.payload.id, record.payload);
    const active = new Set([...latest].filter(([, proposal]) => isActiveProposalState(proposal.state)).map(([id]) => id));
    const records = archive.records.flatMap((record) => {
      if (isActiveProposalChainRecord(record, active)) return [];
      const expiresAt = expirationFor(record, currentRetentionDays);
      return expiresAt !== null && isExpired(expiresAt, nowMs) ? [{ kind: record.kind, id: logicalId(record), expiresAt }] : [];
    });
    const capsules = (archive.capsules ?? []).flatMap((entry) => {
      const capsule = entry?.capsule;
      return capsule && isExpired(capsule.expiresAt, nowMs)
        ? [{ kind: "evidence-capsule", id: capsule.capsuleId, expiresAt: capsule.expiresAt }]
        : [];
    });
    return [...records, ...capsules];
  }

  function checkQuota(currentBytes, budgetBytes = quotaBytes) {
    if (!Number.isFinite(currentBytes) || currentBytes < 0 || !Number.isFinite(budgetBytes) || budgetBytes < 0) return { ok: false, usedFraction: Number.POSITIVE_INFINITY };
    const usedFraction = budgetBytes === 0 ? (currentBytes === 0 ? 0 : Number.POSITIVE_INFINITY) : currentBytes / budgetBytes;
    return { ok: currentBytes <= budgetBytes, usedFraction };
  }

  function scopedRecords(archive, fingerprint) {
    if (archive.projectFingerprint !== fingerprint) return [];
    return archive.records.filter((record) => !recordFingerprint(record) || recordFingerprint(record) === fingerprint);
  }

  function inspectScope(fingerprint) {
    durableSettings();
    const archive = requireStore(store).exportProject();
    const records = scopedRecords(archive, fingerprint);
    const counts = { observations: 0, proposals: 0, decisions: 0, auditEvents: 0 };
    for (const record of records) {
      if (record.kind === "observation") counts.observations += 1;
      else if (record.kind === "proposal") counts.proposals += 1;
      else if (record.kind === "decision") counts.decisions += 1;
      else if (record.kind === "audit-event") counts.auditEvents += 1;
    }
    const usage = typeof store.getProjectUsage === "function"
      ? store.getProjectUsage()
      : { bytesUsed: Buffer.byteLength(JSON.stringify(records), "utf8"), quotaBytes };
    return { ...counts, bytesUsed: usage.bytesUsed, quotaFraction: checkQuota(usage.bytesUsed, usage.quotaBytes).usedFraction };
  }

  function exportScope(fingerprint) {
    if (fingerprint !== projectFingerprint) throw new Error("cross-project-export-forbidden");
    durableSettings();
    const archive = requireStore(store).exportProject();
    if (archive.projectFingerprint !== fingerprint) return { ...archive, projectName: "", projectFingerprint: fingerprint, records: [] };
    const records = scrubExportRecords(scopedRecords(archive, fingerprint), fingerprint);
    return { ...archive, records };
  }

  function exportAll() {
    durableSettings();
    const archive = requireStore(store).exportAll();
    if (archive.projectFingerprint !== projectFingerprint
        || archive.projects.some((project) => project.projectFingerprint !== projectFingerprint)) {
      throw new Error("cross-project-export-forbidden");
    }
    const projects = archive.projects.map((project) => ({
      ...project,
      records: scrubExportRecords(project.records, project.projectFingerprint),
    }));
    const currentProject = projects.find((project) => project.projectFingerprint === projectFingerprint);
    return {
      ...archive,
      records: currentProject?.records ?? scrubExportRecords(archive.records, projectFingerprint),
      projects,
    };
  }

  function exportGlobalRecommendations() {
    durableSettings();
    return requireStore(store).exportGlobalRecommendations();
  }

  function purgeScope({ scope, projectFingerprint: requestedProject, recommendationId } = {}) {
    if (scope !== "all" && requestedProject !== undefined && requestedProject !== projectFingerprint) return { ok: false, reason: "project-partition-mismatch", counts: {}, removedPaths: [] };
    const writableStore = requireStore(store);
    const result = writableStore.purge({ scope, ...(recommendationId === undefined ? {} : { recommendationId }) });
    if (!result.ok) return { ...result, counts: result.counts ?? {}, removedPaths: [] };
    // Per §4/§10: rollback snapshots live under <stateDir>/snapshots/ and must
    // be purged alongside the records they relate to. The store recreates the
    // project subtree on scope="project", so we remove snapshot files before
    // returning; on scope="all" the entire self-evolve/ subtree is gone.
    const snapshotGlobs = [];
    if (scope === "project") {
      const snapshotRoot = typeof writableStore.snapshotRoot === "string" ? writableStore.snapshotRoot : null;
      if (snapshotRoot) {
        try {
          const entries = readdirSync(snapshotRoot);
          for (const entry of entries) snapshotGlobs.push(path.posix.join("snapshots", entry));
          rmSync(snapshotRoot, { recursive: true, force: true });
          try { mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 }); } catch {}
        } catch {}
      }
    }
    const removedPaths = scope === "all"
      ? ["self-evolve"]
      : scope === "project"
        ? [path.posix.join("self-evolve", projectFingerprint)]
        : [];
    return { ok: true, counts: result.counts, removedPaths: [...removedPaths, ...snapshotGlobs] };
  }

  function appendPrivacyAudit(action, details) {
    const timestamp = now();
    // H6-002: scrub detail strings so raw host errors never persist private
    // material (tokens, paths, private names, message contents) in audits.
    const cleanDetails = redactRecordPrivateMaterial({ action, ...details });
    const payloadHash = sha256(JSON.stringify(cleanDetails));
    const event = makeAuditEvent({
      id: sha256(JSON.stringify({ timestamp, payloadHash, projectFingerprint, action })),
      kind: "decision",
      actor: "self-evolve-privacy",
      timestamp,
      payloadHash,
      details: cleanDetails,
    });
    return requireStore(store).appendRecord(wrapRecord("audit-event", event, timestamp));
  }

  function invalidateObservation(observationId, reason) {
    if (!FINGERPRINT.test(String(observationId)) || typeof reason !== "string" || !reason.trim()) return { ok: false, reason: "invalid-correction" };
    const result = appendPrivacyAudit("invalidate-observation", {
      observationId,
      reasonHash: sha256(reason),
      state: "superseded",
    });
    if (result.ok) invalidated.add(observationId);
    return result.ok ? { ok: true, observationId, superseded: true } : result;
  }

  function isObservationEligible(observationId) {
    if (invalidated.has(observationId)) return false;
    if (!store) return true;
    return !store.readRecords("audit-event").some((record) =>
      record.payload?.details?.action === "invalidate-observation"
      && record.payload?.details?.observationId === observationId);
  }

  function excludeRepo(fingerprint) {
    if (fingerprint !== projectFingerprint) return { ok: false, reason: "project-partition-mismatch" };
    const durableStore = requireStore(store);
    const saved = durableStore.updateRepoSettings((current) => makeRepoSettings({ ...current, excluded: true }));
    return saved?.ok === false ? saved : { ok: true, settings: saved.settings.repo };
  }

  return Object.freeze({
    scrubObservation,
    scrubExcerpt,
    createEvidenceCapsule,
    getEvidenceCapsuleSupport,
    checkPartition,
    checkGlobalAggregation,
    publishContribution,
    checkRetention,
    checkQuota,
    scanForForbiddenContent,
    inspectScope,
    exportScope,
    exportAll,
    exportGlobalRecommendations,
    purgeScope,
    invalidateObservation,
    isObservationEligible,
    excludeRepo,
  });
}
