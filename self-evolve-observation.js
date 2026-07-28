import { createHash } from "node:crypto";
import {
  assertEligibility,
  makeEligibilityExplanation,
  makeEvidenceCluster,
  makeObservation,
  makeReceipt,
  recordIncident,
  UNKNOWN_SESSION_LINEAGE_HASH,
} from "./self-evolve-schemas.js";

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/gu;
const COMMON_PROVIDER_TOKEN_RE =
  /\b(?:AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj|svcacct|ant-api03)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dop_v1_[A-Fa-f0-9]{32,})\b/gi;
const INJECTION_MARKER_RE = /\b(?:ignore (?:all |any |the )?(?:previous|prior|above) instructions?|system\s*:|developer\s*:|assistant\s*:|jailbreak|prompt injection)\b/i;
const SELF_REFERENCE_RE = /(?:\/self-evolve|self-evolve(?:'s)?\s+(?:proposal|implementation|output|analysis)|proposal\s+from\s+self-evolve)/i;
const CLARIFICATION_RE = /(?:\?|\b(?:to clarify|clarification|i mean|what i meant|rather than|instead|not .{0,40} but|no,|actually,)\b)/i;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const clusterMetadata = new WeakMap();

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
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

export function hashMessageCursor(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new TypeError("message-required");
  const hostID = message.id ?? message.info?.id ?? message.message?.id;
  if (typeof hostID === "string" && hostID) return hashSignature(`self-evolve-message-id-v1\n${hostID}`);
  return hashSignature(`self-evolve-message-fallback-v1\n${JSON.stringify(message)}`);
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
    for (let start = 0; start + length * 2 <= actions.length; start += 1) {
      const candidate = actions.slice(start, start + length).join("\n");
      let occurrences = 1;
      for (let other = start + length; other + length <= actions.length; other += 1) {
        if (actions.slice(other, other + length).join("\n") === candidate) occurrences += 1;
      }
      if (occurrences < 2) continue;
      const key = signature("procedure", candidate);
      if (!procedures.has(key)) procedures.set(key, { count: occurrences, length });
    }
    if (procedures.size) break;
  }
  return procedures;
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
  });
}

export function extractReceipts(episode, { projectFingerprint, scopeFingerprint, now }) {
  if (!episode || typeof episode !== "object" || !Array.isArray(episode.messages)) throw new TypeError("malformed episode");
  const messages = episode.messages.slice(0, EXTRACT_RULES.maxMessages);
  const usable = messages.filter((message) => message && typeof message === "object" && !message.isSelfEvolveOutput);
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
    if (group.count >= EXTRACT_RULES["repeated-command"].minimumOccurrences) output.push(receipt("repeated-command", key, group.count, episode, { projectFingerprint, scopeFingerprint, now }));
  }
  for (const [key, group] of countBySignature(errors, "tool-error")) {
    if (group.count >= EXTRACT_RULES["repeated-tool-error"].minimumOccurrences) output.push(receipt("repeated-tool-error", key, group.count, episode, { projectFingerprint, scopeFingerprint, now }));
  }
  for (const [key, group] of repeatedProcedures(actions)) {
    output.push(receipt("repeated-manual-procedure", key, group.count, episode, { projectFingerprint, scopeFingerprint, now }));
  }
  for (let index = 0; index < clarifications.length - 1; index += 1) {
    const first = clarifications[index];
    const second = clarifications[index + 1];
    if (second.index - first.index > EXTRACT_RULES["repeated-clarification"].windowMessages) continue;
    const normalized = [first.message.content, second.message.content].map(normalizeForSignature).sort().join("\n");
    output.push(receipt("repeated-clarification", hashSignature(normalized), 2, episode, { projectFingerprint, scopeFingerprint, now }));
    break;
  }

  return output.sort((left, right) => left.receiptType.localeCompare(right.receiptType) || left.signatureHash.localeCompare(right.signatureHash));
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
    createdAt: value.createdAt,
    injectionFlagged: value.injectionFlagged || injectionHeuristic(value).flagged,
    redacted: value.redacted,
  });
}

function incidentRoot(observation) {
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
      const root = incidentRoot(value);
      const observation = observationInput(value, signatureHash, root);
      const key = [observation.structuredFields.receiptType, observation.projectFingerprint, observation.structuredFields.scopeFingerprint, signatureHash].join("\n");
      let group = groups.get(key);
      if (!group) {
        group = {
          cluster: makeEvidenceCluster({
            id: hashSignature(key),
            receiptType: observation.structuredFields.receiptType,
            projectFingerprint: observation.projectFingerprint,
            incidentIds: [],
            scopeFingerprint: observation.structuredFields.scopeFingerprint,
            occurrencesSum: 0,
            firstSeenAt: observation.createdAt,
            lastSeenAt: observation.createdAt,
          }),
          incidents: new Map(),
          contradiction: false,
          injectionFlagged: false,
          outOfOrder: false,
          lastCreatedAt: null,
          lastPolarity: undefined,
        };
        groups.set(key, group);
      }
      if (group.incidents.has(root)) continue;
      if (group.lastCreatedAt !== null && observation.createdAt < group.lastCreatedAt) group.outOfOrder = true;
      group.lastCreatedAt = observation.createdAt;
      const polarity = observation.structuredFields.deterministicOutcome;
      if (typeof polarity === "boolean" && typeof group.lastPolarity === "boolean" && polarity !== group.lastPolarity) group.contradiction = true;
      if (typeof polarity === "boolean") group.lastPolarity = polarity;
      group.injectionFlagged ||= observation.injectionFlagged;
      const recorded = recordIncident(group.cluster, observation, Math.max(group.cluster.lastSeenAt, observation.createdAt));
      if (!recorded.ok) throw new TypeError(recorded.error);
      group.cluster = recorded.state;
      group.incidents.set(root, {
        createdAt: observation.createdAt,
        sessionLineageHash: observation.sessionLineageHash,
      });
    }
  }

  const output = [...groups.values()].map((group) => {
    clusterMetadata.set(group.cluster, {
      incidents: [...group.incidents.values()],
      contradiction: group.contradiction,
      injectionFlagged: group.injectionFlagged,
      outOfOrder: group.outOfOrder,
    });
    return group.cluster;
  });
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

function thresholdTarget(target, actual) {
  return `${target} (actual ${actual})`;
}

export function evaluateEligibility(clusters, thresholds = {}) {
  if (!Array.isArray(clusters)) throw new TypeError("clusters must be an array");
  const minIndependentIncidents = thresholds.minIndependentIncidents ?? 3;
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
      const distinctSessions = new Set(metadata.incidents.map((item) => item.sessionLineageHash ?? UNKNOWN_SESSION_LINEAGE_HASH)).size;
      const now = thresholds.now ?? cluster.lastSeenAt;
      const freshCount = metadata.incidents.filter((item) => item.createdAt <= now && now - item.createdAt <= retentionMs).length;
      const freshnessRatio = metadata.incidents.length ? freshCount / metadata.incidents.length : 0;
      place(distinctSessions >= minDistinctSessions, "minDistinctSessions", thresholdTarget(minDistinctSessions, distinctSessions), "distinct-sessions-not-met");
      place(freshnessRatio >= minFreshnessRatio, "minFreshnessRatio", thresholdTarget(minFreshnessRatio, Number(freshnessRatio.toFixed(3))), "freshness-ratio-not-met");
      place(!metadata.contradiction, "noContradictions", true, "contradicting-observations");
      place(!metadata.injectionFlagged, "noInjectionFlags", true, "injection-flagged");
      place(!metadata.outOfOrder, "chronologicalObservations", true, "out-of-order-observations");
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
