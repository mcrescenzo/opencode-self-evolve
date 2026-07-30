import path from "node:path";
import { partIsExcludedFromEvidence } from "./self-evolve-observation.js";

export const DEFAULT_OPTIONS = Object.freeze({
  minIntervalMs: 10 * 60 * 1000,
  maxAnalyzerRuns: 8,
  maxProposals: 3,
  maxAnalyzerFailures: 3,
  messageLimit: 120,
  transcriptMaxChars: 30000,
  messageMaxChars: 2000,
  minConfidence: 0.72,
  analyzerTimeoutMs: 2 * 60 * 1000,
  sdkTimeoutMs: 15 * 1000,
  cleanupTimeoutMs: 5 * 1000,
  deliveryTimeoutMs: 5 * 1000,
  maxRegistrySessions: 200,
});

const NUMERIC_OPTION_KEYS = Object.keys(DEFAULT_OPTIONS).filter((key) => typeof DEFAULT_OPTIONS[key] === "number");

export const STATUSES = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  ANALYZING: "analyzing",
  PROPOSAL_PENDING: "proposal-pending",
  COOLDOWN: "cooldown",
  DISABLED: "disabled",
});

export const PLACEMENTS = Object.freeze(["global", "repo-local", "plugin-local", "unknown"]);
export const SELF_EVOLVE_MODULE_ID = "mcrescenzo.self-evolve";
export const SELF_EVOLVE_SOURCE = SELF_EVOLVE_MODULE_ID;
export const SELF_EVOLVE_ANALYZER_AGENT = `${SELF_EVOLVE_MODULE_ID}.analyzer`;
export const SELF_EVOLVE_SYNTHESIZER_AGENT = `${SELF_EVOLVE_MODULE_ID}.synthesizer`;
export const SELF_EVOLVE_CRITIC_AGENT = `${SELF_EVOLVE_MODULE_ID}.critic`;
export const LEGACY_SELF_EVOLVE_SOURCE = "self-evolve-plugin";
export const LEGACY_SELF_EVOLVE_AGENTS = Object.freeze({
  analyzer: "self-evolve-analyzer",
  synthesizer: "self-evolve-synthesizer",
  critic: "self-evolve-critic",
});
const SELF_EVOLVE_AGENTS = new Set([
  SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  ...Object.values(LEGACY_SELF_EVOLVE_AGENTS),
]);
const SELF_EVOLVE_SOURCES = new Set([SELF_EVOLVE_SOURCE, LEGACY_SELF_EVOLVE_SOURCE]);
export const PRIVACY_DISCLOSURE = "Privacy: a manual scan sends a bounded, redacted recent-session transcript to the configured model provider for analysis.";
const DURABLE_LIFECYCLE_EVENT_TYPES = new Set([
  "session.compacted",
  "session.idle",
  "session.status",
]);

export function durableEventBody(input) {
  return input?.event && typeof input.event === "object" ? input.event : input;
}

export function isDurableLifecycleEvent(input) {
  return DURABLE_LIFECYCLE_EVENT_TYPES.has(durableEventBody(input)?.type);
}

const VAGUE_TARGET_RE = /^(repo|repository|project|codebase|workspace|everything|various|misc|unknown|general|tooling)$/i;
const UNSAFE_TARGET_RE = /(^|[/\\])(?:\.env(?:\.|$)|\.git(?:[/\\]|$)|\.opencode(?:[/\\]|$)|\.remember(?:[/\\]|$)|\.beads(?:[/\\]|$)|node_modules(?:[/\\]|$)|logs?(?:[/\\]|$)|\.npmrc(?:$|\s)|\.netrc(?:$|\s)|\.pypirc(?:$|\s)|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\s)|.*(?:secret|credential|token|private-key|private_key).*|.*\.(?:pem|key|p12|pfx|log)(?:$|\s))/i;
const SENSITIVE_ACTION_RE = /\b(?:print|paste|dump|show|cat|copy|exfiltrate|upload|send)\b[\s\S]{0,120}\b(?:contents?|secret|token|credential|private key|private-key|\.env|\.npmrc|id_rsa|pem|\.log)\b/i;
const ANSI_CONTROL_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const PRIVATE_KEY_MARKER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----/g;
const COMMON_PROVIDER_TOKEN_RE =
  /\b(?:AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj|svcacct|ant-api03)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dop_v1_[A-Fa-f0-9]{32,})\b/g;
const QUALITY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "onto", "only", "safe", "risk", "low",
  "docs", "repo", "local", "file", "text", "note", "make", "add", "update", "change", "improve", "useful",
]);

function optionNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

export function resolveOptions(options = {}) {
  const resolved = { ...DEFAULT_OPTIONS, ...(options || {}) };
  for (const key of NUMERIC_OPTION_KEYS) {
    const value = optionNumber(resolved[key]);
    if (!Number.isFinite(value) || value < 0 || (key === "minConfidence" && value > 1)) {
      resolved[key] = DEFAULT_OPTIONS[key];
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

export function createSessionState(sessionID, options = {}, nowMs = Date.now()) {
  return {
    sessionID,
    status: STATUSES.ACTIVE,
    createdAt: nowMs,
    updatedAt: nowMs,
    paused: false,
    disabled: false,
    analyzing: false,
    currentAnalysisToken: null,
    analysisSequence: 0,
    lastFinishedAnalysisToken: 0,
    analyzerRuns: 0,
    analyzerFailures: 0,
    proposalCount: 0,
    nextProposalNumber: 1,
    pendingProposal: null,
    proposalFingerprints: new Set(),
    lastAnalyzedAt: 0,
    lastAnalyzedMessageCount: 0,
    lastSeenMessageCount: 0,
    cooldownUntil: 0,
    lastReason: "Self-evolve is ready for manual scans.",
    lastTrigger: null,
    options: resolveOptions(options),
  };
}

export function createRegistry(options = {}) {
  // `registryOptions` is intentionally a reassignable `let`, not the registry
  // binding itself. `setOptions()` below lets a caller re-seed the options
  // used for newly-created session state (and the eviction cap) at any time
  // WITHOUT discarding the `map` or any existing session state it holds. This
  // is what makes it safe for a plugin factory to be invoked more than once:
  // the caller re-seeds options through `setOptions()` instead of throwing
  // away and recreating the whole registry.
  let registryOptions = resolveOptions(options);
  const map = new Map();
  function evictInactiveSessions(keepSessionID, options = registryOptions) {
    const maxSessions = options.maxRegistrySessions;
    // Only a non-finite cap means "uncapped". A maxRegistrySessions <= 0 means
    // "cap at zero" and must fall through so eviction runs eagerly — otherwise
    // the registry Map would grow without any ceiling. The keepSessionID (and
    // any analyzing/pending sessions) are excluded from candidates below, so
    // even a zero cap retains the session currently being served.
    if (!Number.isFinite(maxSessions) || map.size <= maxSessions) return;
    const candidates = [...map.values()]
      .filter((state) => state.sessionID !== keepSessionID && !state.analyzing && !state.pendingProposal)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (map.size > maxSessions && candidates.length > 0) {
      map.delete(candidates.shift().sessionID);
    }
  }
  return {
    map,
    get: (sessionID) => map.get(sessionID),
    has: (sessionID) => map.has(sessionID),
    clear: () => map.clear(),
    delete: (sessionID) => map.delete(sessionID),
    setOptions(newOptions) {
      registryOptions = resolveOptions(newOptions);
    },
    getOrCreate(sessionID, nowMs = Date.now(), seedOptions) {
      const options = seedOptions === undefined ? registryOptions : resolveOptions(seedOptions);
      if (!map.has(sessionID)) map.set(sessionID, createSessionState(sessionID, options, nowMs));
      else map.get(sessionID).updatedAt = Math.max(map.get(sessionID).updatedAt, nowMs);
      evictInactiveSessions(sessionID, options);
      return map.get(sessionID);
    },
  };
}

export function currentStatus(state, nowMs = Date.now()) {
  if (!state) return STATUSES.ACTIVE;
  if (state.disabled) return STATUSES.DISABLED;
  if (state.paused) return STATUSES.PAUSED;
  if (state.analyzing) return STATUSES.ANALYZING;
  if (state.pendingProposal) return STATUSES.PROPOSAL_PENDING;
  if (state.cooldownUntil && state.cooldownUntil > nowMs) return STATUSES.COOLDOWN;
  return STATUSES.ACTIVE;
}

export function syncStatus(state, nowMs = Date.now()) {
  state.status = currentStatus(state, nowMs);
  state.updatedAt = nowMs;
  return state.status;
}

export function reserveAnalysis(state, trigger = {}, nowMs = Date.now(), options = state?.options) {
  const opts = resolveOptions(options);
  const status = currentStatus(state, nowMs);
  if (status === STATUSES.DISABLED) return { allowed: false, reason: "disabled" };
  if (status === STATUSES.PAUSED) return { allowed: false, reason: "paused" };
  if (status === STATUSES.ANALYZING) return { allowed: false, reason: "already-analyzing" };
  if (status === STATUSES.PROPOSAL_PENDING) return { allowed: false, reason: "proposal-pending" };
  if (state.analyzerFailures >= opts.maxAnalyzerFailures) {
    state.disabled = true;
    state.lastReason = `Disabled after ${state.analyzerFailures} analyzer failure(s).`;
    syncStatus(state, nowMs);
    return { allowed: false, reason: "failure-cap" };
  }
  if (state.analyzerRuns >= opts.maxAnalyzerRuns) return { allowed: false, reason: "run-cap" };
  if (state.proposalCount >= opts.maxProposals) return { allowed: false, reason: "proposal-cap" };

  const token = ++state.analysisSequence;
  state.currentAnalysisToken = token;
  state.analyzing = true;
  state.lastTrigger = trigger;
  state.lastReason = "Analyzing recent session activity.";
  syncStatus(state, nowMs);
  return { allowed: true, token };
}

export function beginAnalyzerRun(state, messageCount = 0, nowMs = Date.now()) {
  state.lastSeenMessageCount = Math.max(state.lastSeenMessageCount, messageCount);

  state.analyzerRuns += 1;
  state.lastReason = "Manual self-evolve scan started.";
  syncStatus(state, nowMs);
  return { allowed: true, reason: state.lastReason };
}

function ownsAnalysisReservation(state, token) {
  return token === undefined || state.currentAnalysisToken === token || (!state.analyzing && token > state.lastFinishedAnalysisToken);
}

function staleAnalysisResult(reason, failure = false) {
  return {
    accepted: false,
    failure,
    stale: true,
    reason: reason || "Analysis result ignored because a newer scan is in progress.",
  };
}

export function finishAnalysisFailure(state, reason, nowMs = Date.now(), options = state?.options, messageCount = state?.lastSeenMessageCount ?? 0, token = undefined) {
  if (!ownsAnalysisReservation(state, token)) return staleAnalysisResult(reason, false);
  state.lastFinishedAnalysisToken = Math.max(state.lastFinishedAnalysisToken, token ?? state.lastFinishedAnalysisToken);
  const opts = resolveOptions(options);
  state.analyzing = false;
  state.currentAnalysisToken = null;
  state.analyzerFailures += 1;
  state.lastAnalyzedAt = nowMs;
  state.lastAnalyzedMessageCount = Math.max(state.lastAnalyzedMessageCount, messageCount);
  state.cooldownUntil = nowMs + opts.minIntervalMs;
  state.lastReason = reason || "Analyzer failed.";
  if (state.analyzerFailures >= opts.maxAnalyzerFailures) {
    state.disabled = true;
    state.lastReason = `${state.lastReason} Disabled after ${state.analyzerFailures} analyzer failure(s).`;
  }
  syncStatus(state, nowMs);
  return { accepted: false, failure: true, reason: state.lastReason };
}

export function finishAnalysisSuppressed(state, reason, nowMs = Date.now(), options = state?.options, messageCount = state?.lastSeenMessageCount ?? 0, resetFailures = false, token = undefined) {
  if (!ownsAnalysisReservation(state, token)) return staleAnalysisResult(reason, false);
  state.lastFinishedAnalysisToken = Math.max(state.lastFinishedAnalysisToken, token ?? state.lastFinishedAnalysisToken);
  const opts = resolveOptions(options);
  state.analyzing = false;
  state.currentAnalysisToken = null;
  // Only a clean suppression (analyzer ran and returned valid output but no
  // actionable proposal) clears the failure streak. Forced suppression —
  // paused/disabled/stale-token — must preserve analyzerFailures so the cap
  // cannot be silently reset by pausing during an in-flight LLM call.
  if (resetFailures) state.analyzerFailures = 0;
  state.lastAnalyzedAt = nowMs;
  state.lastAnalyzedMessageCount = Math.max(state.lastAnalyzedMessageCount, messageCount);
  state.cooldownUntil = nowMs + opts.minIntervalMs;
  state.lastReason = reason || "Analyzer returned no actionable proposal.";
  syncStatus(state, nowMs);
  return { accepted: false, failure: false, reason: state.lastReason };
}

export function completeAnalysis(state, rawOutput, context = {}) {
  const nowMs = context.now ?? Date.now();
  const opts = resolveOptions(context.options ?? state.options);
  const messageCount = context.messageCount ?? state.lastSeenMessageCount ?? 0;
  const token = context.token;
  if (!ownsAnalysisReservation(state, token)) return staleAnalysisResult("Analysis result ignored because a newer scan is in progress.");
  state.lastFinishedAnalysisToken = Math.max(state.lastFinishedAnalysisToken, token ?? state.lastFinishedAnalysisToken);
  const parsed = parseAnalyzerOutput(rawOutput);
  if (!parsed.ok) return finishAnalysisFailure(state, parsed.reason, nowMs, opts, messageCount, token);

  const validation = validateAnalyzerPayload(parsed.value, state, { options: opts, targetRoot: context.targetRoot });
  if (!validation.ok) {
    if (validation.failure) return finishAnalysisFailure(state, validation.reason, nowMs, opts, messageCount, token);
    return finishAnalysisSuppressed(state, validation.reason, nowMs, opts, messageCount, true, token);
  }

  const proposal = validation.proposal;
  const id = `se-${state.nextProposalNumber++}`;
  const pendingProposal = {
    ...proposal,
    id,
    fingerprint: validation.fingerprint,
    createdAt: nowMs,
  };
  state.analyzing = false;
  state.currentAnalysisToken = null;
  state.analyzerFailures = 0;
  state.proposalCount += 1;
  state.pendingProposal = pendingProposal;
  state.proposalFingerprints.add(validation.fingerprint);
  state.lastAnalyzedAt = nowMs;
  state.lastAnalyzedMessageCount = Math.max(state.lastAnalyzedMessageCount, messageCount);
  state.cooldownUntil = nowMs + opts.minIntervalMs;
  state.lastReason = `Proposal ${id} pending.`;
  syncStatus(state, nowMs);
  return { accepted: true, proposal: pendingProposal };
}

export function parseAnalyzerOutput(rawOutput) {
  if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) return { ok: true, value: rawOutput };
  if (typeof rawOutput !== "string") return { ok: false, reason: "Analyzer returned no JSON text." };
  const text = rawOutput.trim();
  if (!text || text.startsWith("```") || text.endsWith("```")) return { ok: false, reason: "Analyzer did not return strict JSON." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return { ok: true, value: JSON.parse(text.slice(start, end + 1)) }; } catch {}
    }
    return { ok: false, reason: "Analyzer returned invalid JSON." };
  }
}

function allowedKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function nonEmptyString(value, min = 1) {
  return typeof value === "string" && value.trim().length >= min;
}

function normalizedString(value, max = 1200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function sanitizeAnalyzerText(value, max = 1200) {
  return normalizedString(
    String(value ?? "")
      .replace(ANSI_CONTROL_RE, "")
      .replace(CONTROL_CHAR_RE, " ")
      .replace(/\[([^\]\n]{1,160})\]\((?:https?:|file:|javascript:)[^)]+\)/gi, "$1 [link removed]")
      .replace(/\b(?:https?|file|javascript):\/\/[^\s)]+/gi, "[link removed]")
      .replace(/[`*_~>#|]/g, ""),
    max,
  );
}

// Target path/surface/symbol fields must shed ANSI and C0/C1 control characters
// (terminal/control-sequence injection) without applying markdown sanitization,
// which would strip legitimate filename punctuation such as underscores.
function sanitizeTargetField(value, max) {
  return normalizedString(String(value ?? "").replace(ANSI_CONTROL_RE, "").replace(CONTROL_CHAR_RE, " "), max);
}

function substantiveTokens(value) {
  return (String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])
    .filter((token) => !QUALITY_STOP_WORDS.has(token));
}

function hasSubstance(value, minDistinctTokens = 3) {
  return new Set(substantiveTokens(value)).size >= minDistinctTokens;
}

function targetTerms(targetPath, targetSurface, targetSymbol) {
  const basename = path.basename(targetPath || "", path.extname(targetPath || ""));
  const terms = new Set([
    ...substantiveTokens(basename.replace(/[-_.]/g, " ")),
    ...substantiveTokens(targetSurface),
    ...substantiveTokens(targetSymbol),
  ]);
  return [...terms].filter((term) => term.length >= 3);
}

function mentionsAnyTerm(text, terms) {
  const tokens = new Set(substantiveTokens(text));
  return terms.some((term) => tokens.has(term));
}

export function validateAnalyzerPayload(payload, state, context = {}) {
  const opts = resolveOptions(context.options ?? state?.options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, failure: true, reason: "Analyzer JSON must be an object." };
  }
  if (!allowedKeys(payload, ["proposal", "reason"])) {
    return { ok: false, failure: true, reason: "Analyzer JSON had unexpected top-level fields." };
  }
  if (!("proposal" in payload) || !nonEmptyString(payload.reason, 3)) {
    return { ok: false, failure: true, reason: "Analyzer JSON missing proposal or reason." };
  }
  if (payload.proposal === null) return { ok: false, failure: false, reason: normalizedString(payload.reason, 300) || "No proposal." };

  const proposal = payload.proposal;
  const proposalKeys = ["title", "summary", "evidence", "target", "placement", "risk", "riskMitigation", "confidence", "suggestedAction"];
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal) || !allowedKeys(proposal, proposalKeys)) {
    return { ok: false, failure: true, reason: "Proposal is malformed or has unexpected fields." };
  }
  for (const key of proposalKeys) {
    if (!(key in proposal)) return { ok: false, failure: true, reason: `Proposal missing ${key}.` };
  }
  if (!nonEmptyString(proposal.title, 8) || VAGUE_TARGET_RE.test(proposal.title.trim())) {
    return { ok: false, failure: false, reason: "Proposal title is too vague." };
  }
  if (!nonEmptyString(proposal.summary, 20) || !nonEmptyString(proposal.suggestedAction, 12)) {
    return { ok: false, failure: false, reason: "Proposal summary or suggested action is too vague." };
  }
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0 || proposal.evidence.some((item) => !nonEmptyString(item, 8))) {
    return { ok: false, failure: false, reason: "Proposal lacks concrete evidence." };
  }
  // The advertised schema caps evidence at maxItems:4 and the cleaned output
  // truncates to the first 4. Bound evidence here so the substance and
  // target-relevance gates below see exactly what will be surfaced — a proposal
  // must not clear a gate on an evidence item (index >= 4) that is dropped.
  const boundedEvidence = proposal.evidence.slice(0, 4);
  if (!hasSubstance(`${proposal.title} ${proposal.summary} ${proposal.suggestedAction}`, 4) || boundedEvidence.some((item) => !hasSubstance(item, 3))) {
    return { ok: false, failure: false, reason: "Proposal lacks substantive, evidence-backed detail." };
  }
  if (!proposal.target || typeof proposal.target !== "object" || Array.isArray(proposal.target) || !allowedKeys(proposal.target, ["path", "surface", "symbol"])) {
    return { ok: false, failure: false, reason: "Proposal target is malformed." };
  }
  const targetPath = sanitizeTargetField(proposal.target.path, 500);
  const targetSurface = sanitizeTargetField(proposal.target.surface, 300);
  const targetSymbol = sanitizeTargetField(proposal.target.symbol, 200);
  if ((!targetPath && !targetSurface) || VAGUE_TARGET_RE.test(targetPath || targetSurface)) {
    return { ok: false, failure: false, reason: "Proposal target is too vague." };
  }
  if (isUnsafeTarget(`${targetPath} ${targetSurface}`)) {
    return { ok: false, failure: false, reason: "Proposal targets secret, runtime, dependency, or ignored state." };
  }
  if (!PLACEMENTS.includes(proposal.placement) || proposal.placement === "unknown") {
    return { ok: false, failure: false, reason: "Proposal lacks a safe placement recommendation." };
  }
  const inferredPlacement = classifyPlacement({ path: targetPath, surface: targetSurface, symbol: targetSymbol }, context.targetRoot);
  if (inferredPlacement === "unknown") {
    return { ok: false, failure: false, reason: "Proposal target is outside safe placement scope." };
  }
  if (proposal.placement !== inferredPlacement) {
    return { ok: false, failure: false, reason: `Proposal placement ${proposal.placement} does not match inferred ${inferredPlacement}.` };
  }
  const terms = targetTerms(targetPath, targetSurface, targetSymbol);
  if (terms.length === 0) {
    return { ok: false, failure: false, reason: "Proposal target lacks a concrete term to verify evidence against." };
  }
  const proposalEvidenceText = [proposal.summary, proposal.suggestedAction, ...boundedEvidence].join(" ");
  if (!mentionsAnyTerm(proposalEvidenceText, terms)) {
    return { ok: false, failure: false, reason: "Proposal evidence does not connect to the target." };
  }
  if (!["low", "medium", "high"].includes(proposal.risk) || !nonEmptyString(proposal.riskMitigation, 12)) {
    return { ok: false, failure: false, reason: "Proposal lacks risk or mitigation." };
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1 || proposal.confidence < opts.minConfidence) {
    return { ok: false, failure: false, reason: "Proposal confidence is outside the valid range or below threshold." };
  }
  if (SENSITIVE_ACTION_RE.test(proposal.suggestedAction)) {
    return { ok: false, failure: false, reason: "Proposal suggested action asks to expose sensitive file contents." };
  }

  const cleaned = {
    title: sanitizeAnalyzerText(proposal.title, 140),
    summary: sanitizeAnalyzerText(proposal.summary, 600),
    evidence: boundedEvidence.map((item) => sanitizeAnalyzerText(item, 300)),
    target: { path: targetPath, surface: targetSurface, symbol: targetSymbol },
    placement: proposal.placement,
    risk: proposal.risk,
    riskMitigation: sanitizeAnalyzerText(proposal.riskMitigation, 400),
    confidence: Math.max(0, Math.min(1, proposal.confidence)),
    suggestedAction: sanitizeAnalyzerText(proposal.suggestedAction, 600),
  };
  const fingerprint = fingerprintProposal(cleaned);
  if (state?.proposalFingerprints?.has(fingerprint) || state?.pendingProposal?.fingerprint === fingerprint) {
    return { ok: false, failure: false, reason: "Duplicate proposal suppressed." };
  }
  return { ok: true, proposal: cleaned, fingerprint };
}

export function fingerprintProposal(proposal) {
  return JSON.stringify(
    [
      proposal?.placement,
      proposal?.target?.path,
      proposal?.target?.surface,
      proposal?.target?.symbol,
      proposal?.title,
      proposal?.suggestedAction,
    ].map((s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim()),
  );
}

export function isUnsafeTarget(target) {
  return UNSAFE_TARGET_RE.test(String(target || "").trim());
}

export function classifyPlacement(target, root = "") {
  const rawPath = typeof target === "string" ? target : target?.path;
  const surface = String((typeof target === "string" ? "" : target?.surface) || "").toLowerCase();
  const combined = `${rawPath || ""} ${surface}`.toLowerCase();
  if (!combined.trim() || isUnsafeTarget(combined)) return "unknown";

  const rawPathStr = String(rawPath || "");
  // path.isAbsolute() is POSIX-only in this runtime: it only recognizes leading
  // '/'. Analyzer-authored targets are untrusted text and may be Windows
  // drive-letter (C:\...), UNC (\\server\share), or home-relative (~/...) paths
  // that would otherwise skip the root-containment gate and fall through to
  // "repo-local". Treat those prefixes like the POSIX-absolute branch so they
  // must prove root-containment or resolve to "unknown".
  const looksNonPosixAbsolute =
    /^[a-zA-Z]:[\\/]/.test(rawPathStr) || // Windows drive-letter (C:\ or C:/)
    /^[\\/]{2}/.test(rawPathStr) || // UNC (\\server or //server)
    /^~(?:[\\/]|$)/.test(rawPathStr); // home-relative (~ or ~/...)
  let normalizedPath = rawPathStr.replace(/\\/g, "/");
  const isAbsoluteLike = path.isAbsolute(normalizedPath) || looksNonPosixAbsolute;
  if (normalizedPath) {
    // Resolve BOTH absolute and relative raw paths against the root and reject
    // anything that escapes it. A relative target with ../ segments (e.g.
    // "../../etc/passwd") must not fall through to "repo-local" any more than an
    // absolute out-of-scope path does. Absolute-like targets still require a
    // known root to prove containment.
    if (isAbsoluteLike && !root) return "unknown";
    const base = path.resolve(root || ".");
    const resolved = isAbsoluteLike ? path.resolve(normalizedPath) : path.resolve(base, normalizedPath);
    const rel = path.relative(base, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      normalizedPath = rel.replace(/\\/g, "/");
    } else {
      return "unknown";
    }
  }
  normalizedPath = normalizedPath.replace(/^\.\//, "");

  if (/\bplugin-local\b/.test(surface) || /^plugins\/[^/]+\//.test(normalizedPath)) return "plugin-local";
  if (/\b(global|opencode config|slash command|agent|skill|workflow|instruction)\b/.test(surface)) return "global";
  if (!normalizedPath && !surface) return "unknown";
  if (path.isAbsolute(normalizedPath) && root && !normalizedPath.startsWith(root)) return "unknown";
  return "repo-local";
}

export function parseCommand(args = "") {
  const trimmed = String(args || "").trim();
  if (!trimmed) return { verb: "scan" };
  const [verbRaw, ...rest] = trimmed.split(/\s+/);
  const verb = verbRaw.toLowerCase();
  if (["status", "pause", "resume", "disable", "scan", "help"].includes(verb)) return { verb };
  if (verb === "dismiss") return { verb, proposalID: rest.join(" ").trim() };
  return { verb: "error", message: `Unknown /self-evolve command: ${verbRaw}` };
}

export function applyControlCommand(state, command, nowMs = Date.now(), options = state?.options) {
  const opts = resolveOptions(options);
  switch (command.verb) {
    case "status":
      return { text: statusText(state, nowMs), changed: false };
    case "help":
      return { text: helpText(), changed: false };
    case "pause":
      if (state.disabled) return { text: "Self-evolve is disabled for this session.", changed: false };
      state.paused = true;
      state.analyzing = false;
      state.currentAnalysisToken = null;
      state.lastReason = "Paused by /self-evolve pause.";
      syncStatus(state, nowMs);
      return { text: "Self-evolve manual scans paused for this session.", changed: true };
    case "resume":
      if (state.disabled) return { text: "Self-evolve is disabled for this session and cannot be resumed.", changed: false };
      state.paused = false;
      state.lastReason = "Resumed by /self-evolve resume.";
      syncStatus(state, nowMs);
      return { text: "Self-evolve manual scans resumed for this session.", changed: true };
    case "disable":
      state.disabled = true;
      state.paused = false;
      state.analyzing = false;
      state.currentAnalysisToken = null;
      state.pendingProposal = null;
      state.lastReason = "Disabled by /self-evolve disable.";
      syncStatus(state, nowMs);
      return { text: "Self-evolve disabled for this session.", changed: true };
    case "dismiss": {
      if (!command.proposalID) return { text: "Usage: /self-evolve dismiss <proposal-id>", changed: false };
      if (!state.pendingProposal) return { text: "No pending self-evolve proposal to dismiss.", changed: false };
      if (state.pendingProposal.id !== command.proposalID) {
        return { text: `Pending proposal is ${state.pendingProposal.id}; ${command.proposalID} was not dismissed.`, changed: false };
      }
      const id = state.pendingProposal.id;
      state.pendingProposal = null;
      state.cooldownUntil = Math.max(state.cooldownUntil, nowMs + opts.minIntervalMs);
      state.lastReason = `Dismissed proposal ${id}.`;
      syncStatus(state, nowMs);
      return { text: `Dismissed self-evolve proposal ${id}.`, changed: true };
    }
    default:
      return { text: command.message || "Unknown /self-evolve command.", changed: false };
  }
}

export function statusText(state, nowMs = Date.now()) {
  if (!state) return "Self-evolve has no state for this session yet.";
  const status = syncStatus(state, nowMs);
  const lines = [
    `Self-evolve status: ${status}.`,
    `Analyzer runs: ${state.analyzerRuns}/${state.options.maxAnalyzerRuns}. Failures: ${state.analyzerFailures}/${state.options.maxAnalyzerFailures}.`,
    `Proposals: ${state.proposalCount}/${state.options.maxProposals}. Last analyzed messages: ${state.lastAnalyzedMessageCount}.`,
    `Last reason: ${state.lastReason}`,
  ];
  if (state.cooldownUntil && state.cooldownUntil > nowMs) lines.push(`Cooldown until: ${new Date(state.cooldownUntil).toISOString()}.`);
  if (state.pendingProposal) lines.push(`Pending proposal: ${state.pendingProposal.id} - ${state.pendingProposal.title}`);
  return lines.join("\n");
}

export function helpText() {
  return [
    "Self-evolve commands:",
    PRIVACY_DISCLOSURE,
    "",
    "/self-evolve - run one manual gated scan.",
    "/self-evolve help - show this command summary.",
    "/self-evolve status - show this session's state.",
    "/self-evolve pause - pause manual scans and cancel any in-flight scan result for this session.",
    "/self-evolve resume - resume manual scans for this session.",
    "/self-evolve disable - block future manual scans for this session.",
    "/self-evolve scan - same as /self-evolve.",
    "/self-evolve dismiss <proposal-id> - clear the pending proposal.",
  ].join("\n");
}

function redactPrivateKeys(text) {
  const value = String(text ?? "");
  PRIVATE_KEY_MARKER_RE.lastIndex = 0;
  let copyFrom = 0;
  let redactionStart = null;
  let output = "";
  let match;

  while ((match = PRIVATE_KEY_MARKER_RE.exec(value))) {
    if (match[0].startsWith("-----BEGIN ")) {
      if (redactionStart === null) redactionStart = match.index;
      continue;
    }

    if (redactionStart !== null) {
      output += value.slice(copyFrom, redactionStart);
      output += "[redacted: private key]";
      copyFrom = PRIVATE_KEY_MARKER_RE.lastIndex;
      redactionStart = null;
    }
  }

  if (redactionStart !== null) {
    output += value.slice(copyFrom, redactionStart);
    output += "[redacted: private key]";
    return output;
  }
  if (copyFrom === 0) return value;
  return output + value.slice(copyFrom);
}

export function redactText(text) {
  let value = redactPrivateKeys(text);
  value = value.replace(/\b(Authorization\s*:\s*)[^\r\n]+/gi, "$1[redacted]");
  value = value.replace(/\b((?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi, "$1[redacted]");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]");
  value = value.replace(/\b([A-Z0-9_]*(?:DATABASE_URL|DB_URL|REDIS_URL|MONGO(?:DB)?_URI|POSTGRES(?:QL)?_URL)[A-Z0-9_]*)\s*[:=]\s*(?:"[^"]{8,}"|'[^']{8,}'|[^"'\s,;]{8,})/gi, "$1=[redacted]");
  value = value.replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)\s*[:=]\s*(?:"[^"]{8,}"|'[^']{8,}'|[^"'\s,;]{8,})/gi, "$1=[redacted]");
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, "$1[redacted]@");
  value = value.replace(COMMON_PROVIDER_TOKEN_RE, "[redacted: token]");
  value = value.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[redacted: token]");
  value = value.replace(/\b[A-Za-z0-9_+/=.-]{48,}\b/g, (match) => {
    if (!/[A-Za-z]/.test(match) || !/[0-9]/.test(match)) return match;
    return "[redacted: opaque token]";
  });
  return value;
}

// Step back one UTF-16 code unit when `index` lands on a low surrogate
// (0xDC00-0xDFFF), so a slice at that boundary never severs a surrogate pair
// and emits a lone surrogate into the analyzer prompt.
export function safeSliceIndex(value, index) {
  if (index > 0 && index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0xDC00 && code <= 0xDFFF) return index - 1;
  }
  return index;
}

export function truncateText(text, maxChars, label = "content") {
  const value = String(text || "");
  if (!Number.isFinite(maxChars) || value.length <= maxChars) return value;
  if (maxChars <= 0) return `[truncated ${value.length} chars of ${label}]`;
  const cut = safeSliceIndex(value, maxChars);
  return `${value.slice(0, cut)}\n[truncated ${value.length - cut} chars of ${label}]`;
}

export function truncateTail(text, maxChars, label = "content") {
  const value = String(text || "");
  if (!Number.isFinite(maxChars) || value.length <= maxChars) return value;
  if (maxChars <= 0) return `[omitted ${value.length} chars of ${label}]`;
  const cut = safeSliceIndex(value, value.length - maxChars);
  return `[omitted ${cut} earlier chars of ${label}]\n${value.slice(cut)}`;
}

function partListText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.filter((part) => !partIsExcludedFromEvidence(part)).map(partText).filter(Boolean).join("\n");
}

function partText(part) {
  if (!part || typeof part !== "object") return typeof part === "string" ? part : "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  const state = part.state ?? part;
  const output = state.output ?? state.error ?? state.result;
  if (output === undefined) return "";
  const label = part.tool ?? part.name ?? part.type ?? "tool";
  return `[${label} output] ${typeof output === "string" ? output : JSON.stringify(output)}`;
}

export function messageText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  const parts = message.parts ?? message.info?.parts ?? message.message?.parts;
  if (Array.isArray(parts) && parts.length > 0) return partListText(parts);
  return String(message.text ?? message.content ?? message.info?.text ?? "");
}

function messageID(message, index) {
  return message?.id ?? message?.info?.id ?? message?.messageID ?? message?.info?.messageID ?? `index-${index}`;
}

function messageRole(message) {
  return message?.role ?? message?.info?.role ?? message?.type ?? "message";
}

function messageAgent(message) {
  return message?.agent ?? message?.mode ?? message?.info?.agent ?? message?.info?.mode ?? "";
}

function isSelfEvolveMessage(message) {
  if (SELF_EVOLVE_AGENTS.has(messageAgent(message))) return true;
  const parts = message?.parts ?? message?.info?.parts ?? message?.message?.parts ?? [];
  return Array.isArray(parts) && parts.some((part) => SELF_EVOLVE_SOURCES.has(part?.metadata?.source));
}

function isExcludedEvidenceMessage(message) {
  if (partIsExcludedFromEvidence(message)) return true;
  const parts = message?.parts ?? message?.info?.parts ?? message?.message?.parts;
  return Array.isArray(parts) && parts.length > 0 && parts.every(partIsExcludedFromEvidence);
}

export function buildTranscript(messages, options = {}) {
  const opts = resolveOptions(options);
  const input = Array.isArray(messages) ? messages : [];
  const seen = new Set();
  const unique = [];
  input.forEach((message, index) => {
    const id = messageID(message, index);
    if (seen.has(id) || isSelfEvolveMessage(message) || isExcludedEvidenceMessage(message)) return;
    seen.add(id);
    unique.push(message);
  });
  const selected = opts.messageLimit > 0 ? unique.slice(-opts.messageLimit) : [];
  const lines = selected.map((message, index) => {
    const role = messageRole(message);
    const agent = messageAgent(message);
    const prefix = agent ? `[${role}:${agent}]` : `[${role}]`;
    const text = truncateText(redactText(messageText(message)).trim(), opts.messageMaxChars, `message ${index + 1}`);
    return text ? `${prefix}\n${text}` : "";
  }).filter(Boolean);
  const text = truncateTail(lines.join("\n\n"), opts.transcriptMaxChars, "transcript");
  return {
    text,
    messageCount: unique.length,
    includedMessages: selected.length,
  };
}
