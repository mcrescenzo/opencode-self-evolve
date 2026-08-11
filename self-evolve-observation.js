import { createHash } from "node:crypto";
import {
  asTargetLogicalName,
  assertEligibility,
  canonicalize,
  deepFreeze,
  makeEligibilityExplanation,
  makeEvidenceCluster,
  makeObservation,
  makeReceipt,
  MAX_EVIDENCE_CAPSULE_BYTES,
  ORIGIN_KINDS,
  recordIncident,
  UNKNOWN_EVIDENCE_DOMAIN_ID,
  UNKNOWN_ROOT_LINEAGE_HASH,
  UNKNOWN_SESSION_LINEAGE_HASH,
} from "./self-evolve-schemas.js";

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/gu;
const COMMON_PROVIDER_TOKEN_RE =
  /\b(?:AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj|svcacct|ant-api03)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dop_v1_[A-Fa-f0-9]{32,})\b/gi;
const INJECTION_MARKER_RE = /\b(?:ignore (?:all |any |the )?(?:previous|prior|above) instructions?|system\s*:|developer\s*:|assistant\s*:|jailbreak|prompt injection)\b/i;
const SELF_REFERENCE_RE = /(?:\/self-evolve|self-evolve(?:'s)?\s+(?:proposal|implementation|output|analysis)|proposal\s+from\s+self-evolve)/i;
const CLARIFICATION_RE = /(?:\?|\b(?:to clarify|clarification|i mean|what i meant|rather than|instead|not .{0,40} but|no,|actually,)\b)/i;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUTOMATION_PROVENANCE_SCHEMA = "automation-provenance/v1";
const AUTOMATION_PROVENANCE_MAX_BYTES = 1024;
const AUTOMATION_KINDS = new Set(["control", "display"]);
export const ROOT_LINEAGE_MAX_DEPTH = 16;
const clusterMetadata = new WeakMap();

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const EXTRACT_RULES = deepFreeze({
  maxMessages: 256,
  maxTextCharacters: 8192,
  "repeated-command": {
    fields: ["role", "commandName", "isSelfEvolveOutput"],
    minimumOccurrences: 2,
  },
  "repeated-tool-error": {
    fields: ["role", "toolName", "toolError", "isSelfEvolveOutput"],
    minimumOccurrences: 2,
  },
  "repeated-manual-procedure": {
    fields: ["role", "commandName", "toolName", "isSelfEvolveOutput"],
    minimumOccurrences: 2,
    minimumSteps: 3,
  },
  "repeated-clarification": {
    fields: ["role", "content", "isSelfEvolveOutput"],
    minimumOccurrences: 2,
    windowMessages: 8,
  },
});

export function normalizeForSignature(text) {
  let normalized = String(text ?? "").slice(0, EXTRACT_RULES.maxTextCharacters);
  normalized = normalized.replace(/```[\s\S]*?```/g, " <code> ");
  normalized = normalized.replace(/`[^`\r\n]+`/g, " <code> ");
  normalized = normalized.replace(CONTROL_CHAR_RE, " ");
  normalized = normalized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "<secret>");
  normalized = normalized.replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*["']?[^"'\s,;]{8,}/gi, "<secret>");
  normalized = normalized.replace(COMMON_PROVIDER_TOKEN_RE, "<secret>");
  normalized = normalized.replace(/\b[A-Za-z]:[\\/](?:[^\s"'<>:|?*]+[\\/])*[^\s"'<>:|?*]*/g, "<path>");
  normalized = normalized.replace(/(?:\/[A-Za-z0-9._~-]+){2,}/g, "<path>");
  normalized = normalized.toLowerCase().replace(/\s+/g, " ").trim();
  return `signature-v1:${normalized}`;
}

export function hashSignature(normalizedText) {
  return createHash("sha256").update(String(normalizedText)).digest("hex");
}

export function hashSessionLineage(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) throw new TypeError("session-id-required");
  return hashSignature(`self-evolve-session-lineage-v1\n${sessionID}`);
}

export function hashRootLineage(rootSessionID) {
  if (typeof rootSessionID !== "string" || !rootSessionID) throw new TypeError("root-session-id-required");
  return hashSignature(`self-evolve-root-lineage-v1\n${rootSessionID}`);
}

function canonicalRemoteSource(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let remote = value.trim().replace(/\\/gu, "/");
  const scp = /^(?:[^/@\s]+@)?([^/:\s]+):(.+)$/u.exec(remote);
  if (scp && !remote.includes("://")) remote = `ssh://${scp[1]}/${scp[2]}`;
  let url;
  try { url = new URL(remote); } catch { return null; }
  if (!["git:", "http:", "https:", "ssh:"].includes(url.protocol)) return null;
  if (!url.hostname || url.search || url.hash) return null;
  const defaultPort = (url.protocol === "https:" && url.port === "443")
    || (url.protocol === "http:" && url.port === "80")
    || (url.protocol === "ssh:" && url.port === "22")
    || (url.protocol === "git:" && url.port === "9418");
  const host = url.hostname.toLowerCase() + (!url.port || defaultPort ? "" : `:${url.port}`);
  const sourcePath = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "").replace(/\.git$/iu, "");
  if (!sourcePath || sourcePath === "/") return null;
  return `${host}${sourcePath}`;
}

export function deriveSourceLineage({ remoteUrl, remoteUrls } = {}) {
  const supplied = remoteUrls === undefined ? (remoteUrl ? [remoteUrl] : []) : remoteUrls;
  if (!Array.isArray(supplied) || supplied.some((value) => typeof value !== "string")) {
    return deepFreeze({ lineageStatus: "ambiguous", sourceLineageHash: null });
  }
  if (supplied.length === 0 || supplied.every((value) => value.trim() === "")) {
    return deepFreeze({ lineageStatus: "unknown", sourceLineageHash: null });
  }
  const canonical = supplied.map(canonicalRemoteSource);
  if (canonical.some((value) => value === null)) {
    return deepFreeze({ lineageStatus: "ambiguous", sourceLineageHash: null });
  }
  const distinct = [...new Set(canonical)];
  if (distinct.length !== 1) return deepFreeze({ lineageStatus: "ambiguous", sourceLineageHash: null });
  return deepFreeze({
    lineageStatus: "known",
    sourceLineageHash: hashSignature(`self-evolve-source-lineage-v1\n${distinct[0]}`),
  });
}

export function summarizeGlobalCandidateSupport(facts, { nowMs, retentionMs = DEFAULT_RETENTION_MS } = {}) {
  if (!Array.isArray(facts) || facts.length === 0) throw new TypeError("candidate-support-facts-required");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("invalid-candidate-support-time");
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new TypeError("invalid-candidate-support-retention");
  const incidents = new Map();
  for (const fact of facts) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) throw new TypeError("invalid-candidate-support-fact");
    const key = `${fact.evidenceDomainId}\n${fact.incidentId}`;
    const current = incidents.get(key);
    const next = {
      contributionId: String(fact.contributionId).toLowerCase(),
      evidenceDomainId: String(fact.evidenceDomainId),
      incidentId: String(fact.incidentId),
      occurrenceCount: Number(fact.occurrenceCount),
      observedAt: Number(fact.observedAt),
      firstSeenDay: String(fact.firstSeenDay),
      lastSeenDay: String(fact.lastSeenDay),
      expiresAt: Number(fact.expiresAt),
      rootLineageHash: String(fact.rootLineageHash),
      originKind: String(fact.originKind),
      contradictionFree: fact.contradictionFree === true,
      injectionFree: fact.injectionFree === true,
      chronologyValid: fact.chronologyValid === true,
      correlationValid: fact.correlationValid === true,
    };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(next.contributionId)
        || !/^[a-f0-9]{64}$/u.test(next.evidenceDomainId)
        || !next.incidentId || next.incidentId.length > 128
        || !Number.isSafeInteger(next.occurrenceCount) || next.occurrenceCount < 1
        || !Number.isSafeInteger(next.observedAt) || next.observedAt < 0
        || !/^\d{4}-\d{2}-\d{2}$/u.test(next.firstSeenDay)
        || !/^\d{4}-\d{2}-\d{2}$/u.test(next.lastSeenDay)
        || next.lastSeenDay < next.firstSeenDay
        || !Number.isSafeInteger(next.expiresAt) || next.expiresAt <= next.observedAt
        || !/^[a-f0-9]{64}$/u.test(next.rootLineageHash)) {
      throw new TypeError("invalid-candidate-support-fact");
    }
    if (!current) {
      incidents.set(key, next);
      continue;
    }
    current.occurrenceCount = Math.max(current.occurrenceCount, next.occurrenceCount);
    current.observedAt = Math.min(current.observedAt, next.observedAt);
    current.firstSeenDay = current.firstSeenDay < next.firstSeenDay ? current.firstSeenDay : next.firstSeenDay;
    current.lastSeenDay = current.lastSeenDay > next.lastSeenDay ? current.lastSeenDay : next.lastSeenDay;
    current.expiresAt = Math.min(current.expiresAt, next.expiresAt);
    if (current.rootLineageHash !== next.rootLineageHash || current.originKind !== next.originKind) {
      current.rootLineageHash = UNKNOWN_ROOT_LINEAGE_HASH;
      current.originKind = "unknown";
    }
    current.contradictionFree &&= next.contradictionFree;
    current.injectionFree &&= next.injectionFree;
    current.chronologyValid &&= next.chronologyValid;
    current.correlationValid &&= next.correlationValid;
  }

  const domains = new Map();
  for (const incident of incidents.values()) {
    const domain = domains.get(incident.evidenceDomainId) ?? [];
    domain.push(incident);
    domains.set(incident.evidenceDomainId, domain);
  }
  const ranked = [...domains].map(([domainId, values]) => {
    const occurrenceCount = values.reduce((sum, item) => sum + item.occurrenceCount, 0);
    const nonUnknownUserRootLineageCount = new Set(values
      .filter((item) => item.originKind === "user" && item.rootLineageHash !== UNKNOWN_ROOT_LINEAGE_HASH)
      .map((item) => item.rootLineageHash)).size;
    const fresh = values.filter((item) => item.observedAt <= nowMs && nowMs - item.observedAt <= retentionMs).length;
    return {
      domainId,
      lineageClass: domainId === UNKNOWN_EVIDENCE_DOMAIN_ID ? "local-unknown" : "known",
      independentIncidentCount: values.length,
      occurrenceCount,
      nonUnknownUserRootLineageCount,
      freshnessRatio: values.length ? fresh / values.length : 0,
    };
  }).sort((left, right) => right.independentIncidentCount - left.independentIncidentCount
    || right.occurrenceCount - left.occurrenceCount
    || right.nonUnknownUserRootLineageCount - left.nonUnknownUserRootLineageCount
    || right.freshnessRatio - left.freshnessRatio
    || compareCodepoints(left.domainId, right.domainId));
  const strongest = ranked[0];
  const knownDomainIds = new Set(ranked.filter((item) => item.lineageClass === "known").map((item) => item.domainId));
  const values = [...incidents.values()];
  return deepFreeze({
    contributionIds: values.map((item) => item.contributionId).sort(compareCodepoints),
    strongestSingleDomain: {
      lineageClass: strongest.lineageClass,
      independentIncidentCount: strongest.independentIncidentCount,
      occurrenceCount: strongest.occurrenceCount,
      nonUnknownUserRootLineageCount: strongest.nonUnknownUserRootLineageCount,
      freshnessRatio: strongest.freshnessRatio,
    },
    distributed: {
      independentKnownDomainCount: knownDomainIds.size,
      independentIncidentCount: values.filter((item) => knownDomainIds.has(item.evidenceDomainId)).length,
      unknownLineageCollapsed: domains.has(UNKNOWN_EVIDENCE_DOMAIN_ID),
    },
    integrity: {
      contradictionFree: values.every((item) => item.contradictionFree),
      injectionFree: values.every((item) => item.injectionFree),
      chronologyValid: values.every((item) => item.chronologyValid),
      correlationValid: values.every((item) => item.correlationValid),
    },
    independentDomainCount: domains.size,
    independentIncidentCount: values.length,
    occurrenceCount: values.reduce((sum, item) => sum + item.occurrenceCount, 0),
    firstSeenDay: values.map((item) => item.firstSeenDay).reduce((earliest, value) => earliest < value ? earliest : value),
    lastSeenDay: values.map((item) => item.lastSeenDay).reduce((latest, value) => latest > value ? latest : value),
    expiresAt: values.reduce((earliest, item) => Math.min(earliest, item.expiresAt), Number.MAX_SAFE_INTEGER),
  });
}

export function isAutomationControlPart(part) {
  try {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const marker = part.metadata?.automation;
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
    if (marker.schema !== AUTOMATION_PROVENANCE_SCHEMA || !AUTOMATION_KINDS.has(marker.kind)) return false;
    if (marker.producer !== undefined
      && (typeof marker.producer !== "string" || marker.producer.length < 1 || marker.producer.length > 64)) return false;
    if (marker.nonce !== undefined && typeof marker.nonce !== "string") return false;
    const serialized = JSON.stringify(marker);
    return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= AUTOMATION_PROVENANCE_MAX_BYTES;
  } catch {
    return false;
  }
}

export function partIsExcludedFromEvidence(part) {
  try {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const metadata = part.metadata;
    const hostExcluded = part.ignored === true
      || part.display === true
      || part.displayOnly === true
      || (metadata && typeof metadata === "object" && !Array.isArray(metadata)
        && (metadata.ignored === true || metadata.display === true || metadata.displayOnly === true || metadata.kind === "display"));
    return hostExcluded || isAutomationControlPart(part);
  } catch {
    return false;
  }
}

function evidenceParts(message) {
  const parts = message?.parts ?? message?.info?.parts ?? message?.message?.parts;
  return Array.isArray(parts) ? parts : null;
}

export function extractTargetLogicalNames(messages) {
  if (!Array.isArray(messages)) return [];
  const names = new Set();
  for (const message of messages) {
    for (const part of evidenceParts(message) ?? []) {
      if (!part || typeof part !== "object" || Array.isArray(part) || part.type !== "tool") continue;
      const toolName = part.tool ?? part.name;
      const input = part.state?.input;
      if (toolName !== "skill" || !input || typeof input !== "object" || Array.isArray(input)) continue;
      try {
        const name = asTargetLogicalName(input.name);
        if (name !== null) names.add(name);
      } catch {}
    }
  }
  return [...names].sort();
}

function messageIsExcludedFromEvidence(message) {
  if (partIsExcludedFromEvidence(message)) return true;
  const parts = evidenceParts(message);
  return parts !== null && parts.length > 0 && parts.every(partIsExcludedFromEvidence);
}

function firstDefined(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const key of path) current = current?.[key];
    if (current !== undefined) return current;
  }
  return undefined;
}

function lineageSignal(value, projectFingerprint) {
  const event = value?.event && typeof value.event === "object" ? value.event : value;
  const sessionID = firstDefined(event, [["properties", "sessionID"], ["properties", "session", "id"], ["sessionID"], ["session", "id"]]);
  const parentID = firstDefined(event, [["properties", "parentID"], ["properties", "session", "parentID"], ["parentID"], ["session", "parentID"]]);
  const fingerprint = firstDefined(event, [["properties", "projectFingerprint"], ["properties", "session", "projectFingerprint"], ["projectFingerprint"], ["session", "projectFingerprint"]]) ?? projectFingerprint;
  const owned = firstDefined(event, [["properties", "session", "owned"], ["session", "owned"], ["owned"]]);
  const trustworthy = firstDefined(event, [["properties", "session", "trustworthy"], ["session", "trustworthy"], ["trustworthy"]]);
  const reused = event?.reused === true;
  return { sessionID, parentID, projectFingerprint: fingerprint, owned, trustworthy, reused };
}

function unresolvedRoot(reason) {
  return deepFreeze({ resolved: false, rootLineageHash: UNKNOWN_ROOT_LINEAGE_HASH, originKind: "unknown", reason });
}

function rootOriginKind(signal) {
  if (signal.owned === true) return "plugin-created";
  if (signal.trustworthy !== true) return "unknown";
  if (signal.owned !== undefined && typeof signal.owned !== "boolean") return "unknown";
  return "user";
}

export function resolveRootLineage({
  sessionID,
  projectFingerprint,
  sessions = [],
  preferredRootSessionID,
  preferredRootSessionIDHash,
  maxDepth = ROOT_LINEAGE_MAX_DEPTH,
} = {}) {
  if (typeof sessionID !== "string" || !sessionID) return unresolvedRoot("missing-session");
  if (typeof projectFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(projectFingerprint)) return unresolvedRoot("missing-project-fingerprint");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 256) return unresolvedRoot("invalid-depth-bound");
  if (!Array.isArray(sessions)) return unresolvedRoot("invalid-ancestry");

  const index = new Map();
  for (const value of sessions) {
    const signal = lineageSignal(value, projectFingerprint);
    if (typeof signal.sessionID !== "string" || !signal.sessionID) continue;
    const prior = index.get(signal.sessionID);
    if (prior && JSON.stringify(prior) !== JSON.stringify(signal)) return unresolvedRoot("reused-session-id");
    index.set(signal.sessionID, signal);
  }

  const visited = new Set();
  let currentID = sessionID;
  let depth = 0;
  let delegated = false;
  while (true) {
    if (visited.has(currentID)) return unresolvedRoot("ancestry-cycle");
    visited.add(currentID);
    const current = index.get(currentID);
    if (!current) return unresolvedRoot(depth === 0 ? "missing-session" : "missing-parent");
    if (current.reused) return unresolvedRoot("reused-session-id");
    if (current.projectFingerprint !== projectFingerprint) return unresolvedRoot("cross-project-parent");
    if (current.parentID === undefined || current.parentID === null || current.parentID === "") {
      const rootLineageHash = hashRootLineage(currentID);
      if (preferredRootSessionID !== undefined && preferredRootSessionID !== currentID) return unresolvedRoot("inconsistent-preferred-root");
      if (preferredRootSessionIDHash !== undefined && preferredRootSessionIDHash !== rootLineageHash) return unresolvedRoot("inconsistent-preferred-root-hash");
      const originKind = delegated ? "delegated" : rootOriginKind(current);
      if (!ORIGIN_KINDS.includes(originKind) || originKind === "unknown") return unresolvedRoot("missing-origin-signal");
      return deepFreeze({ resolved: true, rootSessionID: currentID, rootLineageHash, originKind });
    }
    if (typeof current.parentID !== "string") return unresolvedRoot("invalid-parent");
    if (depth >= maxDepth) return unresolvedRoot("depth-exceeded");
    delegated = true;
    currentID = current.parentID;
    depth += 1;
  }
}

export function hashMessageCursor(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new TypeError("message-required");
  const hostID = message.id ?? message.info?.id ?? message.message?.id;
  if (typeof hostID === "string" && hostID) return hashSignature(`self-evolve-message-id-v1\n${hostID}`);
  const jsonValue = JSON.parse(JSON.stringify(message));
  return hashSignature(`self-evolve-message-fallback-v1\n${canonicalize(jsonValue)}`);
}

function signature(kind, value) {
  return hashSignature(normalizeForSignature(`${kind}:${value}`));
}

function countBySignature(items, type) {
  const groups = new Map();
  for (const item of items) {
    const key = signature(type, item.value);
    const current = groups.get(key) ?? { count: 0 };
    current.count += 1;
    groups.set(key, current);
  }
  return groups;
}

function repeatedProcedures(actions) {
  const procedures = new Map();
  for (let length = Math.floor(actions.length / 2); length >= EXTRACT_RULES["repeated-manual-procedure"].minimumSteps; length -= 1) {
    const windows = new Map();
    for (let start = 0; start + length <= actions.length; start += 1) {
      const candidate = actions.slice(start, start + length).join("\n");
      const current = windows.get(candidate) ?? { count: 0, positions: [] };
      current.count += 1;
      current.positions.push(start);
      windows.set(candidate, current);
    }
    for (const [candidate, current] of windows) {
      if (current.count < 2) continue;
      const first = current.positions[0];
      const occurrences = 1 + current.positions.filter((position) => position >= first + length).length;
      if (occurrences < 2) continue;
      const key = signature("procedure", candidate);
      if (!procedures.has(key)) procedures.set(key, { count: occurrences, length, start: first });
    }
    if (procedures.size) break;
  }
  return procedures;
}

function capsuleSummary(summary) {
  const clean = String(summary).replace(/\s+/gu, " ").trim();
  return Buffer.byteLength(clean, "utf8") <= MAX_EVIDENCE_CAPSULE_BYTES
    ? { ok: true, summary: clean }
    : { ok: false, reason: "capsule-summary-too-large" };
}

function receipt(type, signatureHash, occurrences, episode, options) {
  const firstSeenAt = episode.startedAt ?? options.now;
  const lastSeenAt = episode.endedAt ?? options.now;
  return makeReceipt({
    receiptType: type,
    signatureHash,
    occurrences,
    firstSeenAt,
    lastSeenAt,
    projectFingerprint: options.projectFingerprint,
    scopeFingerprint: options.scopeFingerprint,
    targetLogicalName: options.targetLogicalName,
  });
}

export function extractReceipts(episode, { projectFingerprint, scopeFingerprint, now }) {
  if (!episode || typeof episode !== "object" || !Array.isArray(episode.messages)) throw new TypeError("malformed episode");
  const messages = episode.messages.slice(0, EXTRACT_RULES.maxMessages);
  const usable = messages.filter((message) => message
    && typeof message === "object"
    && !message.isSelfEvolveOutput
    && !messageIsExcludedFromEvidence(message));
  const targetNames = extractTargetLogicalNames(usable);
  const targetLogicalName = targetNames.length === 1 ? targetNames[0] : null;
  const commands = usable
    .filter((message) => message.role === "user" && typeof message.commandName === "string" && message.commandName.trim())
    .map((message) => ({ value: message.commandName }));
  const errors = usable
    .filter((message) => message.role === "tool" && typeof message.toolName === "string" && typeof message.toolError === "string" && message.toolError.trim())
    .map((message) => ({ value: `${message.toolName}\n${message.toolError}` }));
  const actions = usable.flatMap((message) => {
    if (typeof message.commandName === "string" && message.commandName.trim()) return [signature("command-step", message.commandName)];
    if (typeof message.toolName === "string" && message.toolName.trim()) return [signature("tool-step", message.toolName)];
    return [];
  });
  const clarifications = usable
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && typeof message.content === "string" && CLARIFICATION_RE.test(message.content));
  const output = [];

  for (const [key, group] of countBySignature(commands, "command")) {
    if (group.count >= EXTRACT_RULES["repeated-command"].minimumOccurrences) output.push(receipt("repeated-command", key, group.count, episode, { projectFingerprint, scopeFingerprint, targetLogicalName, now }));
  }
  for (const [key, group] of countBySignature(errors, "tool-error")) {
    if (group.count >= EXTRACT_RULES["repeated-tool-error"].minimumOccurrences) output.push(receipt("repeated-tool-error", key, group.count, episode, { projectFingerprint, scopeFingerprint, targetLogicalName, now }));
  }
  for (const [key, group] of repeatedProcedures(actions)) {
    output.push(receipt("repeated-manual-procedure", key, group.count, episode, { projectFingerprint, scopeFingerprint, targetLogicalName, now }));
  }
  for (let index = 0; index < clarifications.length - 1; index += 1) {
    const first = clarifications[index];
    const second = clarifications[index + 1];
    if (second.index - first.index > EXTRACT_RULES["repeated-clarification"].windowMessages) continue;
    const normalized = [first.message.content, second.message.content].map(normalizeForSignature).sort().join("\n");
    output.push(receipt("repeated-clarification", hashSignature(normalized), 2, episode, { projectFingerprint, scopeFingerprint, targetLogicalName, now }));
    break;
  }

  return output.sort((left, right) => compareCodepoints(left.receiptType, right.receiptType) || compareCodepoints(left.signatureHash, right.signatureHash));
}

export function deriveEvidenceCapsuleSummary(episode, receipt) {
  if (!episode || typeof episode !== "object" || !Array.isArray(episode.messages)) return { ok: false, reason: "malformed-episode" };
  if (!receipt || typeof receipt !== "object") return { ok: false, reason: "unsupported-receipt" };
  const messages = episode.messages.slice(0, EXTRACT_RULES.maxMessages).filter((message) => message
    && typeof message === "object"
    && !message.isSelfEvolveOutput
    && !messageIsExcludedFromEvidence(message));
  if (receipt.receiptType === "repeated-manual-procedure") {
    const actions = messages.flatMap((message) => {
      if (typeof message?.commandName === "string" && message.commandName.trim()) {
        return [{ signature: signature("command-step", message.commandName), label: message.commandName.replace(/^\/+/, "") }];
      }
      if (typeof message?.toolName === "string" && message.toolName.trim()) {
        return [{ signature: signature("tool-step", message.toolName), label: message.toolName }];
      }
      return [];
    });
    const procedure = repeatedProcedures(actions.map((action) => action.signature)).get(receipt.signatureHash);
    return procedure
      ? capsuleSummary(`Procedure steps ${actions.slice(procedure.start, procedure.start + procedure.length).map((action) => action.label).join(" -> ")} recurred ${receipt.occurrences} times.`)
      : { ok: false, reason: "receipt-evidence-unavailable" };
  }
  if (receipt.receiptType === "repeated-clarification") {
    const clarifications = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message?.role === "user" && typeof message.content === "string" && CLARIFICATION_RE.test(message.content));
    for (let index = 0; index < clarifications.length - 1; index += 1) {
      const first = clarifications[index];
      const second = clarifications[index + 1];
      if (second.index - first.index > EXTRACT_RULES["repeated-clarification"].windowMessages) continue;
      const normalized = [first.message.content, second.message.content].map(normalizeForSignature).sort().join("\n");
      if (hashSignature(normalized) === receipt.signatureHash) {
        return capsuleSummary(`User clarification recurred within ${EXTRACT_RULES["repeated-clarification"].windowMessages} messages and corrected prior instructions.`);
      }
    }
    return { ok: false, reason: "receipt-evidence-unavailable" };
  }
  const match = messages.find((message) => {
    if (!message || typeof message !== "object") return false;
    if (receipt.receiptType === "repeated-command") {
      return message.role === "user"
        && typeof message.commandName === "string"
        && signature("command", message.commandName) === receipt.signatureHash;
    }
    if (receipt.receiptType === "repeated-tool-error") {
      return message.role === "tool"
        && typeof message.toolName === "string"
        && typeof message.toolError === "string"
        && signature("tool-error", `${message.toolName}\n${message.toolError}`) === receipt.signatureHash;
    }
    return false;
  });
  if (!match) return { ok: false, reason: "receipt-evidence-unavailable" };
  if (receipt.receiptType === "repeated-command") {
    const commandName = match.commandName.replace(/^\/+/, "");
    return capsuleSummary(`Command ${commandName} recurred ${receipt.occurrences} times and required repeated handling.`);
  }
  if (receipt.receiptType !== "repeated-tool-error") return { ok: false, reason: "unsupported-receipt" };
  const errorCode = /\b(?:E[A-Z0-9_]{2,31}|[A-Z][A-Z0-9]*_[A-Z0-9_]{1,31})\b/u.exec(match.toolError)?.[0];
  return capsuleSummary(`Tool ${match.toolName} repeatedly failed${errorCode ? ` with ${errorCode}` : ""} (${receipt.occurrences} occurrences).`);
}

export function isSelfReference(observation) {
  if (!observation || typeof observation !== "object") return false;
  if (observation.isSelfEvolveOutput === true) return true;
  const eventKind = observation.structuredFields?.eventKind;
  return typeof eventKind === "string" && SELF_REFERENCE_RE.test(eventKind);
}

export function injectionHeuristic(observation) {
  const structured = observation?.structuredFields ?? {};
  const text = Object.entries(structured).map(([key, value]) => `${key}:${String(value)}`).join(" ");
  const reasons = [];
  if (CONTROL_CHAR_RE.test(text)) reasons.push("control-characters");
  CONTROL_CHAR_RE.lastIndex = 0;
  if (INJECTION_MARKER_RE.test(text)) reasons.push("prompt-injection-marker");
  if (/\b([a-z0-9_-]+)(?:\s+\1){7,}\b/i.test(text)) reasons.push("excessive-token-repetition");
  if (isSelfReference(observation) || SELF_REFERENCE_RE.test(text)) reasons.push("self-evolve-output-quote");
  return deepFreeze({ flagged: reasons.length > 0, reasons });
}

function observationInput(value, signatureHash, incidentId) {
  return makeObservation({
    id: value.id,
    projectFingerprint: value.projectFingerprint,
    receiptIds: [signatureHash],
    structuredFields: value.structuredFields,
    incidentId,
    sessionLineageHash: value.sessionLineageHash ?? UNKNOWN_SESSION_LINEAGE_HASH,
    rootLineageHash: value.rootLineageHash ?? UNKNOWN_ROOT_LINEAGE_HASH,
    originKind: value.originKind ?? "unknown",
    createdAt: value.createdAt,
    injectionFlagged: value.injectionFlagged || injectionHeuristic(value).flagged,
    redacted: value.redacted,
  });
}

function underlyingIncidentId(observation) {
  // Parent/child work on one task, quoted summaries, and observer retries are one
  // underlying incident by contract; session/root lineage is evaluated separately.
  return observation.childSessionParentID || observation.quotedIncidentId || observation.incidentId;
}

export function correlateObservations(observations) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  const groups = new Map();
  for (const value of observations) {
    if (isSelfReference(value)) continue;
    const signatureHashes = value.signatureHash ? [value.signatureHash] : value.receiptIds;
    if (!Array.isArray(signatureHashes) || !signatureHashes.length) continue;
    for (const signatureHash of [...new Set(signatureHashes)]) {
      if (value.quotedSignatureHash === signatureHash) continue;
      const root = underlyingIncidentId(value);
      const observation = observationInput(value, signatureHash, root);
      const targetLogicalName = observation.structuredFields.targetLogicalName ?? null;
      const key = [observation.structuredFields.receiptType, observation.projectFingerprint, observation.structuredFields.scopeFingerprint, targetLogicalName ?? "<untargeted>", signatureHash].join("\n");
      let group = groups.get(key);
      if (!group) {
        group = {
          cluster: makeEvidenceCluster({
            id: hashSignature(key),
            receiptType: observation.structuredFields.receiptType,
            projectFingerprint: observation.projectFingerprint,
            incidentIds: [],
            scopeFingerprint: observation.structuredFields.scopeFingerprint,
            targetLogicalName,
            occurrencesSum: 0,
            firstSeenAt: observation.createdAt,
            lastSeenAt: observation.createdAt,
          }),
          incidents: new Map(),
          contradiction: false,
          injectionFlagged: false,
          outOfOrder: false,
          correlationFailure: false,
          lastCreatedAt: null,
          lastPolarity: undefined,
        };
        groups.set(key, group);
      }
      if (group.incidents.has(root)) continue;
      const recorded = recordIncident(group.cluster, observation, Math.max(group.cluster.lastSeenAt, observation.createdAt));
      if (!recorded.ok) {
        group.correlationFailure = true;
        continue;
      }
      if (group.lastCreatedAt !== null && observation.createdAt < group.lastCreatedAt) group.outOfOrder = true;
      group.lastCreatedAt = observation.createdAt;
      const polarity = observation.structuredFields.deterministicOutcome;
      if (typeof polarity === "boolean" && typeof group.lastPolarity === "boolean" && polarity !== group.lastPolarity) group.contradiction = true;
      if (typeof polarity === "boolean") group.lastPolarity = polarity;
      group.injectionFlagged ||= observation.injectionFlagged;
      group.cluster = recorded.state;
      group.incidents.set(root, {
        createdAt: observation.createdAt,
        sessionLineageHash: observation.sessionLineageHash,
        rootLineageHash: observation.rootLineageHash,
        originKind: observation.originKind,
      });
    }
  }

  const output = [...groups.values()].map((group) => {
    clusterMetadata.set(group.cluster, {
      incidents: [...group.incidents.values()],
      contradiction: group.contradiction,
      injectionFlagged: group.injectionFlagged,
      outOfOrder: group.outOfOrder,
      correlationFailure: group.correlationFailure,
    });
    return group.cluster;
  });
  return output.sort((left, right) => compareCodepoints(left.id, right.id));
}

function thresholdTarget(target, actual) {
  return `${target} (actual ${actual})`;
}

export function evaluateEligibility(clusters, thresholds = {}) {
  if (!Array.isArray(clusters)) throw new TypeError("clusters must be an array");
  const minIndependentIncidents = thresholds.minIndependentIncidents ?? 2;
  const minOccurrencesSum = thresholds.minOccurrencesSum ?? 3;
  const minDistinctSessions = thresholds.minDistinctSessions ?? 2;
  const minFreshnessRatio = thresholds.minFreshnessRatio ?? 0.5;
  const retentionMs = thresholds.retentionMs ?? DEFAULT_RETENTION_MS;
  const scope = thresholds.scope ?? "repository";
  if (!Number.isInteger(minDistinctSessions) || minDistinctSessions < 1) throw new TypeError("invalid minDistinctSessions");
  if (!Number.isFinite(minFreshnessRatio) || minFreshnessRatio < 0 || minFreshnessRatio > 1) throw new TypeError("invalid minFreshnessRatio");
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new TypeError("invalid retentionMs");
  if (!["repository", "global"].includes(scope)) throw new TypeError("invalid scope");

  return clusters.map((cluster) => {
    const base = assertEligibility(cluster, { minIncidents: minIndependentIncidents, minOccurrences: minOccurrencesSum });
    const metadata = clusterMetadata.get(cluster);
    const met = {};
    const missed = {};
    const reasons = [];
    const place = (passed, name, value, reason) => {
      (passed ? met : missed)[name] = value;
      if (!passed && reason) reasons.push(reason);
    };
    place(!base.thresholdsMissed.minIncidents, "minIndependentIncidents", thresholdTarget(minIndependentIncidents, cluster.incidentIds.length), "independent-incidents-not-met");
    place(!base.thresholdsMissed.minOccurrences, "minOccurrencesSum", thresholdTarget(minOccurrencesSum, cluster.occurrencesSum), "occurrences-sum-not-met");

    if (!metadata) {
      place(false, "correlationMetadata", true, "correlation-metadata-unavailable");
    } else {
      const distinctSessions = new Set(metadata.incidents
        .filter((item) => item.originKind === "user" && item.rootLineageHash !== UNKNOWN_ROOT_LINEAGE_HASH)
        .map((item) => item.rootLineageHash)).size;
      const now = thresholds.now ?? cluster.lastSeenAt;
      const freshCount = metadata.incidents.filter((item) => item.createdAt <= now && now - item.createdAt <= retentionMs).length;
      const freshnessRatio = metadata.incidents.length ? freshCount / metadata.incidents.length : 0;
      place(distinctSessions >= minDistinctSessions, "minDistinctSessions", thresholdTarget(minDistinctSessions, distinctSessions), "distinct-sessions-not-met");
      place(freshnessRatio >= minFreshnessRatio, "minFreshnessRatio", thresholdTarget(minFreshnessRatio, Number(freshnessRatio.toFixed(3))), "freshness-ratio-not-met");
      place(!metadata.contradiction, "noContradictions", true, "contradicting-observations");
      place(!metadata.injectionFlagged, "noInjectionFlags", true, "injection-flagged");
      place(!metadata.outOfOrder, "chronologicalObservations", true, "out-of-order-observations");
      place(!metadata.correlationFailure, "correlationIntegrity", true, "correlation-failure");
    }
    if (scope === "global") {
      place(thresholds.explicitGlobalDesignation === true, "explicitGlobalDesignation", true, "global-designation-required");
    } else {
      met.repositoryScopeDefault = true;
    }
    const eligible = Object.keys(missed).length === 0;
    return makeEligibilityExplanation({
      clusterId: cluster.id,
      eligible,
      reasons: eligible ? ["all-thresholds-met"] : reasons,
      thresholdsMet: met,
      thresholdsMissed: missed,
    });
  });
}
