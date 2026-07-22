import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  ConsentState,
  Observation,
  makeAuditEvent,
  makeConsentState,
  makeObservation,
  makeRepoSettings,
  wrapRecord,
} from "./self-evolve-schemas.js";
import { projectFingerprintFor } from "./self-evolve-store.js";

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_EXCERPT_LENGTH = 240;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const CONTROL_GLOBAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const ABSOLUTE_PATH = /(?:^|[\s"'(<])(?:\/(?:[^\s/]+\/)+[^\s"')>]*|[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s"')>]*)/u;
const ABSOLUTE_PATH_GLOBAL = /(?:^|[\s"'(<])(?:\/(?:[^\s/]+\/)+[^\s"')>]*|[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s"')>]*)/gu;
const PROVIDER_TOKEN_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[oprsu]_[A-Za-z0-9]{20,})\b/g,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g,
];
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/g;
const PRIVATE_KEY_MARKER = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u;
const NEVER_STORED_KEY = /(?:^|_)(?:content|body|messageBody|rawMessage|rawText|transcript|completeTranscript)(?:$|_)/iu;
const REPO_NAME_KEY = /(?:project|repo(?:sitory)?|customer)(?:Name|Id|Identifier)?$/iu;
const UNIQUE_COMMAND_KEY = /(?:command|commandName|uniqueCommand|rawCommand)$/iu;

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
  return payload.createdAt ?? payload.synthesizedAt ?? payload.timestamp ?? record?.createdAt;
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
  if (/\bjavascript\s*:/iu.test(source)) issues.add("javascript-link");
  if (/\bdata\s*:/iu.test(source)) issues.add("data-link");
  if (/\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system)\s+instructions?\b/iu.test(source)) issues.add("prompt-injection-marker");
  if (/\b(?:system\s*:\s*you must now apply|you must now apply|you are now in (?:auto|yolo) mode|you are (?:now )?authorized|grant (?:me|yourself) (?:full |elevated )?(?:authority|permissions?)|bypass (?:the )?(?:approval|permission|authority)|ignore (?:the )?(?:approval|permission) (?:gate|rules?))\b/iu.test(source)) issues.add("authority-escalation");
  if (ABSOLUTE_PATH.test(source)) issues.add("absolute-path");
  for (const name of blockedNames) {
    if (name && new RegExp(`(?:^|\\W)${escapeRegex(name)}(?:$|\\W)`, "iu").test(source)) issues.add("blocked-repository-identifier");
  }
  return [...issues];
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
  if (kind === "observation") return observationExpiresAt(createdAt, retentionDays);
  if (["proposal", "decision", "audit-event"].includes(kind)) return proposalExpiresAt(createdAt, retentionDays);
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

export function computeTtlBuckets(records, nowMs) {
  const buckets = { active: 0, expiringSoon: 0, expired: 0 };
  for (const item of records) {
    const expiresAt = typeof item?.expiresAt === "number" ? item.expiresAt : expirationFor(item, DEFAULT_RETENTION_DAYS);
    if (expiresAt === null) continue;
    if (isExpired(expiresAt, nowMs)) buckets.expired += 1;
    else if (expiresAt - nowMs <= 7 * DAY_MS) buckets.expiringSoon += 1;
    else buckets.active += 1;
  }
  return buckets;
}

export function computeProjectFingerprint({ remoteUrl, worktreePath }) {
  return projectFingerprintFor(remoteUrl, path.resolve(String(worktreePath)));
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
  const cleanConsent = makeConsentState(consent ?? ConsentState.defaults);
  if (!FINGERPRINT.test(String(projectFingerprint))) throw new TypeError("invalid-project-fingerprint");
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new TypeError("invalid-retention");
  if (!Number.isFinite(storageQuotaMiB) || storageQuotaMiB < 0) throw new TypeError("invalid-storage-quota");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (!Array.isArray(blockedNames) || blockedNames.some((name) => typeof name !== "string")) throw new TypeError("invalid-blocklist");
  const invalidated = new Set();
  const quotaBytes = Math.floor(storageQuotaMiB * 1024 * 1024);

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

  function scrubObservation(observation) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return { ok: false, reason: "invalid-observation" };
    if (!observation.projectFingerprint) return { ok: false, reason: "project-fingerprint-required" };
    if (observation.projectFingerprint !== projectFingerprint) return { ok: false, reason: "project-partition-mismatch" };
    let rejected = null;
    walk(observation, (value, key) => {
      if (rejected) return;
      if (NEVER_STORED_KEY.test(key)) rejected = "raw-message-content-forbidden";
      else if (typeof value === "string") {
        const scan = scanForForbiddenContent(value);
        if (scan.issues.includes("control-characters") || scan.issues.includes("nul-byte")) rejected = "control-characters";
        else if (scan.issues.includes("provider-token") || scan.issues.includes("private-key")) rejected = "secret-marker";
      }
    });
    if (rejected) return { ok: false, reason: rejected };
    if (observation.scope === "global" || observation.structuredFields?.scope === "global") {
      const global = assertSafeGlobalClaim(observation, { blockedNames });
      if (!global.ok || !cleanConsent.crossRepoAggregation) return { ok: false, reason: global.reason ?? "cross-repo-consent-required" };
    }
    try {
      const sanitized = makeObservation(Object.fromEntries(Observation.fields.map((key) => [key, observation[key]])));
      return successfulObservation(sanitized);
    } catch (error) {
      return { ok: false, reason: String(error.message).split(":", 1)[0] };
    }
  }

  /** Returns heuristic redaction only; "redacted" is not a secrecy guarantee. */
  function scrubExcerpt({ text, maxLength = DEFAULT_EXCERPT_LENGTH } = {}) {
    if (!cleanConsent.sanitizedExcerpts) return { ok: false, reason: "sanitized-excerpts-consent-required" };
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

  function checkPartition(record, requestedScope) {
    const expected = requestedFingerprint(requestedScope);
    const actual = recordFingerprint(record);
    if (!FINGERPRINT.test(String(expected)) || actual !== expected) return { ok: false, allowedScope: null };
    return { ok: true, allowedScope: requestedScope };
  }

  function checkGlobalAggregation(records, requestedScope) {
    if (!cleanConsent.crossRepoAggregation) return { ok: false, reason: "cross-repo-consent-required", sanitized: [] };
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

  function checkRetention(nowMs = now()) {
    const archive = requireStore(store).exportAll();
    return archive.records.flatMap((record) => {
      const expiresAt = expirationFor(record, retentionDays);
      return expiresAt !== null && isExpired(expiresAt, nowMs) ? [{ kind: record.kind, id: logicalId(record), expiresAt }] : [];
    });
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
    const archive = requireStore(store).exportAll();
    const records = scopedRecords(archive, fingerprint);
    const counts = { observations: 0, proposals: 0, decisions: 0, auditEvents: 0 };
    for (const record of records) {
      if (record.kind === "observation") counts.observations += 1;
      else if (record.kind === "proposal") counts.proposals += 1;
      else if (record.kind === "decision") counts.decisions += 1;
      else if (record.kind === "audit-event") counts.auditEvents += 1;
    }
    const bytesUsed = Buffer.byteLength(JSON.stringify(records), "utf8");
    return { ...counts, bytesUsed, quotaFraction: checkQuota(bytesUsed).usedFraction };
  }

  function exportScope(fingerprint) {
    const archive = requireStore(store).exportAll();
    if (archive.projectFingerprint !== fingerprint) return { ...archive, projectName: "", projectFingerprint: fingerprint, records: [] };
    const records = [];
    for (const record of scopedRecords(archive, fingerprint)) {
      if (record.kind !== "observation") {
        records.push(record);
        continue;
      }
      const result = scrubObservation(record.payload);
      if (!result.ok) throw new Error(`unsafe-observation:${result.reason}`);
      records.push({ ...record, payload: result.sanitized });
    }
    return { ...archive, records };
  }

  function purgeScope({ scope, projectFingerprint: requestedProject } = {}) {
    if (scope !== "all" && requestedProject !== undefined && requestedProject !== projectFingerprint) return { ok: false, reason: "project-partition-mismatch", counts: {}, removedPaths: [] };
    const writableStore = requireStore(store);
    const result = writableStore.purge({ scope });
    if (!result.ok) return { ...result, counts: result.counts ?? {}, removedPaths: [] };
    // Per §4/§10: rollback snapshots live under <stateDir>/snapshots/ and must
    // be purged alongside the records they relate to. The store recreates the
    // project subtree on scope="project", so we remove snapshot files before
    // returning; on scope="all" the entire self-evolve/ subtree is gone.
    const snapshotGlobs = [];
    if (scope === "project" || scope === "all") {
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
    return { counts: result.counts, removedPaths: [...removedPaths, ...snapshotGlobs] };
  }

  function appendPrivacyAudit(action, details) {
    const timestamp = now();
    const cleanDetails = { action, ...details };
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
    const current = durableStore.getSettings().repo;
    const settings = makeRepoSettings({ ...current, excluded: true });
    const saved = durableStore.setRepoSettings(settings);
    return saved?.ok === false ? saved : { ok: true, settings: saved };
  }

  return Object.freeze({
    scrubObservation,
    scrubExcerpt,
    checkPartition,
    checkGlobalAggregation,
    checkRetention,
    checkQuota,
    scanForForbiddenContent,
    inspectScope,
    exportScope,
    purgeScope,
    invalidateObservation,
    isObservationEligible,
    excludeRepo,
  });
}
