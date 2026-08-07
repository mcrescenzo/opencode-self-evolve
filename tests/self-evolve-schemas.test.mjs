import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as schemas from "../self-evolve-schemas.js";

const H = (character) => character.repeat(64);
const PROJECT = H("a");
const SCOPE = H("b");
const CURRENT = H("c");
const PROPOSED = H("d");
const CLUSTER = H("e");

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function legacyEnvelope(kind, payload) {
  return {
    schemaVersion: schemas.SCHEMA_VERSION,
    kind,
    id: createHash("sha256").update(`${kind}\n${canonicalize(payload)}`).digest("hex"),
    createdAt: 300,
    payload,
  };
}

test("errorReasonCode consistently extracts bounded reason prefixes", () => {
  assert.equal(schemas.errorReasonCode(new Error("invalid-input: detail"), "fallback"), "invalid-input");
  assert.equal(schemas.errorReasonCode("plain-reason", "fallback"), "plain-reason");
  assert.equal(schemas.errorReasonCode(new Error(""), "fallback"), "fallback");
  assert.equal(schemas.errorReasonCode(null, "fallback"), "fallback");
});

test("shared record and object helpers preserve latest-record and undefined-stripping semantics", () => {
  const first = { id: "envelope-1", payload: { id: "logical", value: 1 } };
  const latest = { id: "envelope-2", payload: { id: "logical", value: 2 } };
  assert.equal(schemas.latestByLogicalId([first, latest]).get("logical"), latest);
  assert.equal(schemas.latestByLogicalId([first, latest], { withPayload: true }).get("logical"), latest.payload);
  assert.deepEqual(schemas.stripUndefined({ kept: false, empty: null, removed: undefined }), { kept: false, empty: null });
});

function globalSettings(overrides = {}) {
  return schemas.makeGlobalSettings({
    createdAt: 100,
    updatedAt: 100,
    allowedSkillRoots: ["/skills"],
    ...overrides,
  });
}

function repoSettings(overrides = {}) {
  return schemas.makeRepoSettings({ projectFingerprint: PROJECT, ...overrides });
}

function proposal(overrides = {}) {
  return schemas.makeProposal({
    id: "proposal-1",
    projectFingerprint: PROJECT,
    clusterId: CLUSTER,
    skillTarget: { canonicalRoot: "/skills", relativePath: "review/SKILL.md", currentHash: CURRENT },
    proposedContentHash: PROPOSED,
    rationaleText: "Repeated deterministic evidence supports this bounded skill change.",
    synthesizedAt: 100,
    synthesizerModelId: "mock/model",
    criticScore: 0.95,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    injectionFlagged: false,
    ...overrides,
  });
}

function decision(current, newState, overrides = {}) {
  const actor = current.state === "critic-pending" && newState === "pending"
    ? "self-evolve-critic"
    : ["applied", "rolled-back"].includes(newState) ? "self-evolve-applier" : "human-reviewer";
  return schemas.makeDecision({
    proposalId: current.id,
    targetHash: current.skillTarget.currentHash,
    proposedContentHash: current.proposedContentHash,
    decisionVersion: current.decisionVersion + 1,
    actor,
    timestamp: 200,
    nonce: `nonce-${current.decisionVersion + 1}`,
    priorState: current.state,
    newState,
    ...overrides,
  });
}

function observation(overrides = {}) {
  return schemas.makeObservation({
    id: H("1"),
    projectFingerprint: PROJECT,
    receiptIds: [H("2")],
    structuredFields: { receiptType: "repeated-command", scopeFingerprint: SCOPE, occurrences: 2, messageCount: 4 },
    incidentId: "incident-1",
    sessionLineageHash: H("3"),
    createdAt: 150,
    injectionFlagged: false,
    redacted: true,
    ...overrides,
  });
}

function cluster(overrides = {}) {
  return schemas.makeEvidenceCluster({
    id: CLUSTER,
    receiptType: "repeated-command",
    projectFingerprint: PROJECT,
    incidentIds: [],
    scopeFingerprint: SCOPE,
    occurrencesSum: 0,
    firstSeenAt: 100,
    lastSeenAt: 100,
    ...overrides,
  });
}

test("scalar validators clean bounded values and reject malformed values", () => {
  assert.equal(schemas.asString("  value  ", { max: 5 }), "value");
  assert.equal(schemas.asNonEmptyString(" x "), "x");
  assert.equal(schemas.asEnum("auto", ["manual", "auto"]), "auto");
  assert.equal(schemas.asInt(3, { min: 0, max: 3 }), 3);
  assert.equal(schemas.asTimestamp(0), 0);
  assert.equal(schemas.asSha256Hex(H("A")), H("a"));
  assert.equal(schemas.asFingerprint(PROJECT), PROJECT);
  assert.equal(schemas.asMode("yolo"), "yolo");
  assert.equal(schemas.asPath("skills/review/SKILL.md/"), "skills/review/SKILL.md");

  assert.throws(() => schemas.asString("long", { max: 3 }), /out-of-bounds/);
  assert.throws(() => schemas.asString("bad\u0000text"), /control-character/);
  assert.throws(() => schemas.asNonEmptyString("  "), /empty-string/);
  assert.throws(() => schemas.asEnum("yolo", ["manual"]), /invalid-enum/);
  assert.throws(() => schemas.asInt(-1), /out-of-bounds/);
  assert.throws(() => schemas.asTimestamp(-1), /out-of-bounds/);
  assert.throws(() => schemas.asSha256Hex("abc"), /invalid-sha256/);
  assert.throws(() => schemas.asPath("../outside"), /path-escape/);
  assert.throws(() => schemas.asPath("skills/*.md"), /glob-path/);
});

test("schema specs, defaults, and validated records are deeply frozen", () => {
  const consent = schemas.makeConsentState();
  const budgets = schemas.makeBudgets();
  const settings = globalSettings();
  assert.deepEqual(consent, {
    passiveCalls: false,
    durableObservations: false,
    sanitizedExcerpts: false,
    crossRepoAggregation: false,
  });
  assert.deepEqual(budgets, schemas.DEFAULT_BUDGETS);
  assert.equal(settings.mode, "manual");
  assert.equal(settings.retentionDays, 30);
  assert.ok(Object.isFrozen(schemas.GlobalSettings));
  assert.ok(Object.isFrozen(settings));
  assert.ok(Object.isFrozen(settings.consent));
  assert.ok(Object.isFrozen(settings.allowedSkillRoots));
});

test("settings enforce versions, canonical roots, booleans, retention, and budget bounds", () => {
  assert.throws(() => globalSettings({ schemaVersion: "9.0.0" }), /unsupported-version/);
  assert.throws(() => globalSettings({ allowedSkillRoots: ["relative/root"] }), /non-canonical-root/);
  assert.throws(() => globalSettings({ paused: "yes" }), /must be boolean/);
  assert.throws(() => globalSettings({ retentionDays: 0 }), /out-of-bounds/);
  assert.throws(() => schemas.makeBudgets({ tokensPerSynthesis: -1 }), /out-of-bounds/);
  assert.throws(() => repoSettings({ budgets: { unknownBudget: 1 } }), /unexpected field/);
  assert.deepEqual(repoSettings({ budgets: { passiveCallsPerHour: 2 } }).budgets, { passiveCallsPerHour: 2 });
  assert.deepEqual(Object.keys(repoSettings()), schemas.RepoSettings.fields);
  assert.equal("consent" in repoSettings(), false, "consent is installation-wide, not repository-scoped");
  assert.throws(() => repoSettings({ consent: schemas.makeConsentState() }), /unexpected field consent/);
  assert.throws(() => globalSettings({ allowedSkillRoots: Array.from({ length: 33 }, (_, i) => `/skills/${i}`) }), /out-of-bounds/);
});

test("budget defaults and repository overrides use distinct complete and partial contracts", () => {
  assert.deepEqual(schemas.makeBudgets({}), schemas.DEFAULT_BUDGETS);
  assert.deepEqual(repoSettings({ budgets: { idleDebounceMs: 25 } }).budgets, { idleDebounceMs: 25 });
  assert.throws(() => schemas.makeBudgets({ unknown: 1 }), /unexpected field unknown/u);
  assert.throws(() => repoSettings({ budgets: { unknown: 1 } }), /unexpected field unknown/u);
});

test("settings migration is structural and partition validators enforce its documented boundary", () => {
  const current = globalSettings();
  assert.equal(schemas.migrateSettings(current), current);
  assert.throws(() => schemas.makeGlobalSettings(schemas.migrateSettings({ ...current, paused: "yes" })), /must be boolean/u);
  const legacy = schemas.SUPPORTED_SCHEMA_VERSIONS.find((version) => version !== schemas.SCHEMA_VERSION);
  assert.ok(legacy);
  assert.throws(() => schemas.makeGlobalSettings(schemas.migrateSettings({ ...current, schemaVersion: legacy, paused: "yes" })), /must be boolean/u);
  const combined = schemas.migrateSettings({ schemaVersion: legacy, global: current, repo: repoSettings() });
  assert.equal(combined.schemaVersion, schemas.SCHEMA_VERSION);
  assert.deepEqual(schemas.makeGlobalSettings(combined.global), current);
  assert.deepEqual(schemas.makeRepoSettings(combined.repo), repoSettings());
});

test("global aggregate claims use an exact bounded versioned allowlist", () => {
  const claim = schemas.makeAggregateClaim({
    schemaVersion: schemas.SCHEMA_VERSION,
    aggregateId: H("1"),
    claimType: "global-skill-candidate",
    receiptType: "repeated-command",
    signatureHash: H("2"),
    incidentHash: H("3"),
    occurrenceCount: 2,
    firstSeenDay: "2026-07-01",
    lastSeenDay: "2026-07-22",
    createdAt: 100,
    expiresAt: 200,
  });
  assert.deepEqual(Object.keys(claim), schemas.AggregateClaim.fields);
  assert.ok(Object.isFrozen(claim));
  assert.throws(() => schemas.makeAggregateClaim({ ...claim, rawText: "secret" }), /unexpected field/);
  assert.throws(() => schemas.makeAggregateClaim({ ...claim, claimType: "unknown" }), /invalid-enum/);
  assert.throws(() => schemas.makeAggregateClaim({ ...claim, firstSeenDay: "2026-02-30" }), /UTC day/);
  assert.throws(
    () => schemas.makeAggregateClaim({ ...claim, firstSeenDay: "2021-13-01" }),
    (error) => error instanceof TypeError && /malformed-payload.*UTC day/u.test(error.message),
  );
  assert.throws(() => schemas.makeAggregateClaim({ ...claim, expiresAt: 100 }), /expire after creation/);
});

test("record envelopes are canonical, content-addressed, versioned, and corruption detecting", () => {
  const first = schemas.wrapRecord("proposal", proposal(), 300);
  const reordered = schemas.wrapRecord("proposal", { ...proposal() }, 999);
  assert.equal(first.id, reordered.id, "createdAt is not part of kind+payload content identity");
  assert.deepEqual(schemas.assertRecord(first), first);
  assert.throws(() => schemas.wrapRecord("unknown-kind", {}, 0), /invalid-enum/);
  assert.throws(() => schemas.assertRecord({ ...first, schemaVersion: "0.3.0" }), /unsupported-version/);
  assert.throws(() => schemas.assertRecord({ ...first, id: H("f") }), /corrupt-record/);
  assert.throws(() => schemas.assertRecord({ ...first, kind: "receipt" }), /malformed-payload/);
});

test("the supported schema version list always retains a migration path off the previous release", () => {
  const supported = schemas.SUPPORTED_SCHEMA_VERSIONS;
  assert.ok(Object.isFrozen(supported), "the supported version list must be frozen");
  assert.equal(supported.at(-1), schemas.SCHEMA_VERSION, "the current version must be listed last");
  // Guards the July 2026 regression: bumping SCHEMA_VERSION without listing its predecessor made
  // every already-persisted record fail validation and get quarantined as damaged.
  assert.ok(supported.length >= 2, "bumping SCHEMA_VERSION requires keeping the prior version readable");
  const ordered = [...supported].sort((a, b) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  assert.deepEqual(supported, ordered, "supported versions must be listed oldest to newest");
  assert.equal(new Set(supported).size, supported.length, "supported versions must be unique");
});

test("records written by a compatible earlier schema version are read and normalized, not quarantined", () => {
  const current = schemas.wrapRecord("proposal", proposal(), 300);
  assert.ok(
    schemas.SUPPORTED_SCHEMA_VERSIONS.includes(schemas.SCHEMA_VERSION),
    "the current version must be a supported version",
  );
  for (const legacy of schemas.SUPPORTED_SCHEMA_VERSIONS.filter((v) => v !== schemas.SCHEMA_VERSION)) {
    const stored = { ...current, schemaVersion: legacy };
    const read = schemas.assertRecord(stored);
    assert.equal(read.schemaVersion, schemas.SCHEMA_VERSION, `${legacy} must be normalized to current`);
    assert.equal(read.id, current.id, `${legacy} record identity must survive migration`);
    assert.deepEqual(read.payload, current.payload, `${legacy} payload must be preserved`);
  }
  assert.throws(() => schemas.assertRecord({ ...current, schemaVersion: "0.1.0" }), /unsupported-version/);
  assert.throws(() => schemas.assertRecord({ ...current, schemaVersion: "9.9.9" }), /unsupported-version/);
});

test("target-less legacy evidence envelopes retain historical hash compatibility and normalize to null", () => {
  const currentReceipt = schemas.makeReceipt({
    receiptType: "repeated-command", signatureHash: H("4"), occurrences: 2,
    firstSeenAt: 100, lastSeenAt: 200, projectFingerprint: PROJECT, scopeFingerprint: SCOPE,
  });
  const { targetLogicalName: _receiptTarget, ...legacyReceipt } = currentReceipt;
  const currentObservation = observation();
  const { targetLogicalName: _observationTarget, ...legacyStructuredFields } = currentObservation.structuredFields;
  const legacyObservation = { ...currentObservation, structuredFields: legacyStructuredFields };
  const currentCluster = cluster();
  const { targetLogicalName: _clusterTarget, ...legacyCluster } = currentCluster;

  const normalized = [
    schemas.assertRecord(legacyEnvelope("receipt", legacyReceipt)),
    schemas.assertRecord(legacyEnvelope("observation", legacyObservation)),
    schemas.assertRecord(legacyEnvelope("evidence-cluster", legacyCluster)),
  ];
  assert.equal(normalized[0].payload.targetLogicalName, null);
  assert.equal(normalized[1].payload.structuredFields.targetLogicalName, null);
  assert.equal(normalized[2].payload.targetLogicalName, null);
  assert.equal(normalized.every((record) => record.id !== legacyEnvelope(record.kind, record.kind === "observation" ? legacyObservation : record.kind === "receipt" ? legacyReceipt : legacyCluster).id), true);
});

test("settings written by a compatible earlier schema version are normalized to the current version", () => {
  for (const legacy of schemas.SUPPORTED_SCHEMA_VERSIONS.filter((v) => v !== schemas.SCHEMA_VERSION)) {
    assert.equal(globalSettings({ schemaVersion: legacy }).schemaVersion, schemas.SCHEMA_VERSION);
    assert.equal(repoSettings({ schemaVersion: legacy }).schemaVersion, schemas.SCHEMA_VERSION);
  }
  assert.throws(() => globalSettings({ schemaVersion: "9.0.0" }), /unsupported-version/);
  assert.throws(() => globalSettings({ schemaVersion: "0.1.0" }), /unsupported-version/);
});

test("mode resolution follows kill, pause, exclusion, opt-out, repo, global, default precedence", () => {
  assert.equal(schemas.resolveMode("yolo", "auto"), "auto");
  assert.equal(schemas.resolveMode("auto", "inherit"), "auto");
  assert.equal(schemas.resolveMode(undefined, undefined), "manual");
  assert.equal(schemas.resolveMode("yolo", "yolo", { repoOptOut: true }), "manual");
  assert.equal(schemas.resolveMode("yolo", "yolo", { processExcluded: true }), "manual");
  assert.equal(schemas.resolveMode("yolo", "yolo", { paused: true }), "manual");
  assert.equal(schemas.resolveMode("yolo", "yolo", { circuitBreakerOpen: true }), "manual");
  assert.equal(schemas.resolveMode("yolo", "yolo", { killSwitchActive: true }), "manual");
  assert.equal(schemas.resolveMode("corrupt", "yolo"), "manual");
  assert.equal(schemas.resolveMode("yolo", "yolo", { killSwitchActive: "ambiguous" }), "manual");
  assert.equal(schemas.resolveMode("yolo", "yolo", { hostSupported: false }), "manual");
});

test("mode transitions update the requested scope, preserve precedence, and audit downgrades", () => {
  const repoChange = schemas.transitionMode(globalSettings({ mode: "auto" }), repoSettings(), { scope: "repo", mode: "yolo" }, 200, "operator");
  assert.equal(repoChange.ok, true);
  assert.equal(repoChange.state.repo.mode, "yolo");
  assert.equal(repoChange.state.effectiveMode, "yolo");
  assert.equal(repoChange.state.unattendedApplyAllowed, true);
  assert.equal(repoChange.events[0].kind, "mode-change");

  const globalDowngrade = schemas.transitionMode(globalSettings({ mode: "yolo" }), repoSettings(), "auto", 200, "operator");
  assert.equal(globalDowngrade.ok, true);
  assert.equal(globalDowngrade.state.global.mode, "auto");
  assert.equal(globalDowngrade.state.unattendedApplyAllowed, false);

  const killed = schemas.transitionMode(globalSettings({ mode: "auto", killSwitchActive: true }), repoSettings(), { scope: "repo", mode: "yolo", overrides: { killSwitchActive: false } }, 200, "operator");
  assert.equal(killed.ok, true);
  assert.equal(killed.state.repo.mode, "yolo");
  assert.equal(killed.state.effectiveMode, "manual");

  const bad = schemas.transitionMode(globalSettings(), repoSettings(), { scope: "repo", mode: "invalid" }, 200, "operator");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid-enum/);
});

test("episode cursor debounces idle events, rejects leases and out-of-order starts", () => {
  const cursor = schemas.makeEpisodeCursor({ sessionIDHash: H("1") });
  assert.deepEqual(cursor, {
    sessionIDHash: H("1"),
    lastIdleAt: 0,
    lastObservedMessageHash: null,
    leaseNonce: null,
  });
  assert.throws(() => schemas.makeEpisodeCursor({ sessionID: "session-1" }), /unexpected field/);
  assert.equal(schemas.canStartEpisode(cursor, 100, 1500), true);
  const active = schemas.beginEpisode(cursor, 100, "lease-1");
  assert.equal(active.leaseNonce, "lease-1");
  assert.equal(schemas.canStartEpisode(active, 5000, 1500), false);
  assert.throws(() => schemas.beginEpisode(active, 200, "lease-2"), /lease-conflict/);
  assert.throws(() => schemas.beginEpisode({ ...cursor, lastIdleAt: 500 }, 499, "lease-2"), /out-of-order/);
  assert.equal(schemas.canStartEpisode({ ...cursor, lastIdleAt: 1000 }, 2000, 1500), false);
  assert.equal(schemas.canStartEpisode({ ...cursor, lastIdleAt: 1000 }, 2500, 1500), true);
});

test("receipt validates type, independent timestamps, counts, and scope hashes", () => {
  const receipt = schemas.makeReceipt({
    receiptType: "repeated-tool-error",
    signatureHash: H("1"),
    occurrences: 2,
    firstSeenAt: 10,
    lastSeenAt: 20,
    projectFingerprint: PROJECT,
    scopeFingerprint: SCOPE,
  });
  assert.equal(receipt.occurrences, 2);
  assert.equal(receipt.targetLogicalName, null, "legacy receipts default the new target field");
  assert.equal(schemas.makeReceipt({ ...receipt, targetLogicalName: "durable-review" }).targetLogicalName, "durable-review");
  assert.throws(() => schemas.makeReceipt({ ...receipt, targetLogicalName: "Durable Review" }), /invalid-skill-name/);
  assert.throws(() => schemas.makeReceipt({ ...receipt, occurrences: 0 }), /out-of-bounds/);
  assert.throws(() => schemas.makeReceipt({ ...receipt, lastSeenAt: 9 }), /out-of-order/);
  assert.throws(() => schemas.makeReceipt({ ...receipt, receiptType: "raw-message" }), /invalid-enum/);
});

test("observation accepts only fixed typed primitives and rejects raw bodies or transcripts", () => {
  assert.equal(observation().redacted, true);
  assert.equal(observation({ structuredFields: { ...observation().structuredFields, targetLogicalName: null } }).structuredFields.targetLogicalName, null);
  assert.equal(observation({ structuredFields: { ...observation().structuredFields, targetLogicalName: "durable-review" } }).structuredFields.targetLogicalName, "durable-review");
  assert.throws(() => observation({ structuredFields: { ...observation().structuredFields, targetLogicalName: "../private" } }), /invalid-skill-name/);
  assert.throws(() => observation({ rawMessageBody: "secret text" }), /unexpected field/);
  assert.throws(() => observation({ transcript: "complete transcript" }), /unexpected field/);
  assert.throws(() => observation({ sessionID: "raw-host-session" }), /unexpected field/);
  assert.throws(() => observation({ sessionLineageHash: "raw-host-session" }), /invalid-sha256/);
  assert.throws(() => observation({ structuredFields: { ...observation().structuredFields, rawMessageBody: "secret" } }), /privacy-field-rejected/);
  assert.throws(() => observation({ structuredFields: { ...observation().structuredFields, transcript: ["secret"] } }), /privacy-field-rejected/);
  assert.throws(() => observation({ structuredFields: { eventKind: { nested: "not primitive" } } }), /malformed-string/);
  for (const [field, value] of [
    ["eventKind", "sk-abcdefghijklmnopqrstuvwxyz"],
    ["toolErrorCode", "ghp_abcdefghijklmnopqrstuvwxyz"],
    ["clarificationCategory", "-----BEGIN PRIVATE KEY-----"],
  ]) {
    assert.throws(() => observation({ structuredFields: { [field]: value } }), /privacy-field-rejected/u);
  }
  assert.throws(() => observation({ receiptIds: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, "0")) }), /out-of-bounds/);
});

test("legacy evidence clusters default a nullable target and reject malformed targets", () => {
  assert.equal(cluster().targetLogicalName, null);
  assert.equal(cluster({ targetLogicalName: "durable-review" }).targetLogicalName, "durable-review");
  assert.throws(() => cluster({ targetLogicalName: "/skills/durable-review" }), /invalid-skill-name/);
});

test("proposal enforces rationale, target, critic, hashes, state, and coordination bounds", () => {
  assert.throws(() => proposal({ rationaleText: "x".repeat(2049) }), /out-of-bounds/);
  assert.throws(() => proposal({ rationaleText: "é".repeat(1100) }), /out-of-bounds/);
  assert.throws(() => proposal({ skillTarget: { canonicalRoot: "/skills", relativePath: "../escape", currentHash: CURRENT } }), /path-escape/);
  assert.throws(() => proposal({ skillTarget: { canonicalRoot: "/skills", relativePath: "/absolute", currentHash: CURRENT } }), /relativePath must be relative/);
  assert.throws(() => proposal({ criticScore: 1.1 }), /out-of-bounds/);
  assert.throws(() => proposal({ state: "unknown" }), /invalid-enum/);
  assert.throws(() => proposal({ decisionVersion: -1 }), /out-of-bounds/);
  assert.throws(() => proposal({ burnedNonceHashes: Array(129).fill(H("1")) }), /out-of-bounds/);
});

test("proposal content and synthesis admission records have exact bounded structural linkage", () => {
  const content = schemas.makeProposalContent({
    proposalId: "proposal-1", contentHash: PROPOSED, contentEncoding: "base64",
    chunkIndex: 0, chunkCount: 2, content: "YWJj",
  });
  const attempt = schemas.makeSynthesisAttempt({
    outcomeId: H("f"), proposalId: "proposal-1", projectFingerprint: PROJECT,
    clusterId: CLUSTER, targetHash: CURRENT, admittedAt: 100, state: "admitted",
  });
  assert.equal(schemas.wrapRecord("proposal-content", content, 100).kind, "proposal-content");
  assert.equal(schemas.wrapRecord("synthesis-attempt", attempt, 100).kind, "synthesis-attempt");
  assert.throws(() => schemas.makeProposalContent({ ...content, content: "not base64!" }), /content must be base64/u);
  assert.throws(() => schemas.makeProposalContent({ ...content, proposalId: undefined }), /missing proposalId|empty-string|malformed-string/u);
  assert.throws(() => schemas.makeSynthesisAttempt({ ...attempt, state: "complete" }), /invalid-enum/u);
  assert.throws(() => schemas.makeSynthesisAttempt({ ...attempt, rawPrompt: "forbidden" }), /unexpected field rawPrompt/u);
});

test("new-skill proposal and decision schemas accept only the exact must-not-exist sentinel", () => {
  const item = proposal({ skillTarget: { canonicalRoot: "/skills", relativePath: "new-skill/SKILL.md", currentHash: "must-not-exist" } });
  assert.equal(schemas.makeProposal(item).skillTarget.currentHash, "must-not-exist");
  assert.equal(decision(item, "approved").targetHash, "must-not-exist");
  assert.throws(() => schemas.makeProposal({ ...item, skillTarget: { ...item.skillTarget, currentHash: "MUST-NOT-EXIST" } }), /invalid-sha256/u);
});

test("proposal content requires canonical base64 and a chunkIndex below chunkCount", () => {
  const base = { proposalId: "proposal-1", contentHash: PROPOSED, contentEncoding: "base64", chunkIndex: 0, chunkCount: 1, content: Buffer.from("abc").toString("base64") };
  assert.equal(schemas.makeProposalContent(base).content, "YWJj");
  // Non-canonical base64 (wrong padding / length) is rejected even though the charset is valid.
  assert.throws(() => schemas.makeProposalContent({ ...base, content: "A" }), /canonical base64/u);
  assert.throws(() => schemas.makeProposalContent({ ...base, content: "YWJ" }), /canonical base64/u);
  // chunkIndex must be strictly less than chunkCount.
  assert.throws(() => schemas.makeProposalContent({ ...base, chunkIndex: 1, chunkCount: 1 }), /chunkIndex/u);
  assert.throws(() => schemas.makeProposalContent({ ...base, chunkIndex: 2, chunkCount: 2 }), /chunkIndex/u);
});

test("global mode transition rejects a timestamp older than the current settings version", () => {
  const prior = globalSettings({ updatedAt: 500 });
  const fresh = schemas.transitionMode(prior, repoSettings(), { scope: "global", mode: "auto" }, 1_000, "operator");
  assert.equal(fresh.ok, true);
  assert.equal(fresh.state.global.updatedAt, 1_000);
  const stale = schemas.transitionMode(prior, repoSettings(), { scope: "global", mode: "yolo" }, 200, "operator");
  assert.equal(stale.ok, false);
  assert.match(stale.error, /stale-timestamp/u);
});

test("every allowed proposal state transition succeeds and emits a decision audit", () => {
  const edges = {
    "critic-pending": ["pending", "failed-closed"],
    pending: ["approved", "rejected", "superseded", "failed-closed"],
    approved: ["applied", "superseded", "failed-closed"],
    applied: ["rolled-back", "failed-closed"],
  };
  for (const [priorState, nextStates] of Object.entries(edges)) {
    for (const newState of nextStates) {
      const current = proposal({ state: priorState });
      const result = schemas.transitionProposalState(current, decision(current, newState), 201);
      assert.equal(result.ok, true, `${priorState}->${newState}: ${result.error}`);
      assert.equal(result.state.state, newState);
      assert.equal(result.state.decisionVersion, 1);
      assert.equal(result.state.burnedNonceHashes.length, 1);
      assert.equal(result.events[0].kind, "decision");
    }
  }
});

test("proposal CAS rejects stale, duplicate, replayed, out-of-order, unauthorized, and invalid transitions", () => {
  const current = proposal();
  const staleState = schemas.transitionProposalState(current, decision(current, "approved", { priorState: "approved" }), 201);
  assert.match(staleState.error, /stale-prior-state/);

  const staleVersion = schemas.transitionProposalState(current, decision(current, "approved", { decisionVersion: 2 }), 201);
  assert.match(staleVersion.error, /stale-decision-version/);

  const invalid = schemas.transitionProposalState(current, decision(current, "applied"), 201);
  assert.match(invalid.error, /invalid-transition/);

  const unauthorized = schemas.transitionProposalState(proposal({ state: "approved" }), decision(proposal({ state: "approved" }), "applied", { actor: "human-reviewer" }), 201);
  assert.match(unauthorized.error, /unauthorized-actor/);
  const unauthorizedCriticCompletion = schemas.transitionProposalState(proposal({ state: "critic-pending" }), decision(proposal({ state: "critic-pending" }), "pending", { actor: "human-reviewer" }), 201);
  assert.match(unauthorizedCriticCompletion.error, /unauthorized-actor/);

  const future = schemas.transitionProposalState(current, decision(current, "approved", { timestamp: 300 }), 201);
  assert.match(future.error, /out-of-order/);

  const accepted = schemas.transitionProposalState(current, decision(current, "approved"), 201);
  const replay = schemas.transitionProposalState(
    proposal({ state: "approved", decisionVersion: 1, burnedNonceHashes: accepted.state.burnedNonceHashes }),
    decision(proposal({ state: "approved", decisionVersion: 1 }), "superseded", { nonce: "nonce-1" }),
    202,
  );
  assert.match(replay.error, /replayed-decision/);

  const invalidated = proposal({ state: "approved", criticPassed: false });
  assert.match(schemas.transitionProposalState(invalidated, decision(invalidated, "applied"), 201).error, /release-gates-failed/);
});

test("proposal CAS rejects cross-proposal and cross-hash decisions", () => {
  const current = proposal();
  assert.match(schemas.transitionProposalState(current, decision(current, "approved", { proposalId: "proposal-other" }), 201).error, /cross-scope/);
  assert.match(schemas.transitionProposalState(current, decision(current, "approved", { targetHash: H("f") }), 201).error, /cross-scope/);
  assert.match(schemas.transitionProposalState(current, decision(current, "approved", { proposedContentHash: H("f") }), 201).error, /cross-scope/);
});

test("burnNonce is deterministic and nonce decisions remain bounded", () => {
  const current = proposal();
  const change = decision(current, "approved");
  assert.equal(schemas.burnNonce(change), schemas.burnNonce(change));
  assert.match(schemas.burnNonce(change), /^[a-f0-9]{64}$/);
  assert.throws(() => decision(current, "approved", { nonce: "x".repeat(129) }), /out-of-bounds/);
});

test("apply claims permit one active claim, replace expired claims, and reject unauthorized actors", () => {
  const current = proposal({ state: "approved" });
  const acquired = schemas.acquireApplyClaim([], current, 1000, 500, "self-evolve-applier");
  assert.equal(acquired.ok, true);
  assert.equal(acquired.state.length, 1);
  assert.equal(schemas.isExpired(acquired.state[0], 1499), false);
  assert.equal(schemas.isExpired(acquired.state[0], 1500), true);

  const conflict = schemas.acquireApplyClaim(acquired.state, current, 1200, 500, "self-evolve-applier");
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /lease-conflict/);

  const replaced = schemas.acquireApplyClaim(acquired.state, current, 1500, 500, "self-evolve-applier");
  assert.equal(replaced.ok, true);
  assert.equal(replaced.state.length, 1);
  assert.equal(replaced.state[0].acquiredAt, 1500);

  const unauthorized = schemas.acquireApplyClaim([], current, 1000, 500, "reviewer");
  assert.match(unauthorized.error, /unauthorized-actor/);
  assert.match(schemas.acquireApplyClaim([], current, 1000, 0, "self-evolve-applier").error, /out-of-bounds/);
  assert.match(schemas.acquireApplyClaim([], proposal(), 1000, 500, "self-evolve-applier").error, /proposal-not-approved/);
  assert.match(schemas.acquireApplyClaim([], proposal({ state: "approved", injectionFlagged: true }), 1000, 500, "self-evolve-applier").error, /release-gates-failed/);
});

test("claim schema and active-claim invariant reject duplicate and out-of-order leases", () => {
  const claim = schemas.makeApplyClaim({ proposalId: "proposal-1", leaseNonce: "lease", acquiredAt: 10, expiresAt: 20, actor: "self-evolve-applier" });
  assert.equal(schemas.oneActiveClaimPerProposal([claim]), true);
  assert.throws(() => schemas.oneActiveClaimPerProposal([claim, { ...claim, leaseNonce: "lease-2" }]), /lease-conflict/);
  assert.throws(() => schemas.makeApplyClaim({ ...claim, expiresAt: 10 }), /out-of-order/);
});

test("releasing an apply claim clears state and emits a bounded lease audit", () => {
  const claim = schemas.makeApplyClaim({ proposalId: "proposal-1", leaseNonce: "lease", acquiredAt: 10, expiresAt: 20, actor: "self-evolve-applier" });
  const released = schemas.releaseApplyClaim(claim, "apply completed");
  assert.equal(released.ok, true);
  assert.equal(released.state, null);
  assert.equal(released.events[0].kind, "lease");
  assert.match(schemas.releaseApplyClaim(claim, "x".repeat(513)).error, /out-of-bounds/);
});

test("incident recording is idempotent and rejects cross-project or cross-correlation scope", () => {
  const first = schemas.recordIncident(cluster(), observation(), 200);
  assert.equal(first.ok, true);
  assert.deepEqual(first.state.incidentIds, ["incident-1"]);
  assert.equal(first.state.occurrencesSum, 2);

  const duplicate = schemas.recordIncident(first.state, observation(), 200);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.state.occurrencesSum, 2);

  const otherProject = schemas.recordIncident(cluster(), observation({ projectFingerprint: H("f") }), 200);
  assert.match(otherProject.error, /cross-scope/);
  const otherScope = schemas.recordIncident(cluster(), observation({ structuredFields: { ...observation().structuredFields, scopeFingerprint: H("f") } }), 200);
  assert.match(otherScope.error, /cross-scope/);
  const future = schemas.recordIncident(cluster(), observation({ createdAt: 300 }), 200);
  assert.match(future.error, /out-of-order/);
});

test("evidence clusters dedupe incidents, enforce list/count bounds, and explain eligibility", () => {
  const deduped = cluster({ incidentIds: ["one", "one", "two"], occurrencesSum: 3 });
  assert.deepEqual(deduped.incidentIds, ["one", "two"]);
  assert.throws(() => cluster({ occurrencesSum: -1 }), /out-of-bounds/);
  assert.throws(() => cluster({ incidentIds: Array.from({ length: 257 }, (_, i) => `incident-${i}`) }), /out-of-bounds/);

  const missed = schemas.assertEligibility(deduped, { minIncidents: 3, minOccurrences: 3 });
  assert.equal(missed.eligible, false);
  assert.deepEqual(missed.thresholdsMissed, { minIncidents: 3 });
  const met = schemas.assertEligibility(deduped, { minIncidents: 2, minOccurrences: 3 });
  assert.equal(met.eligible, true);
  assert.deepEqual(met.thresholdsMissed, {});
});

test("mode authority matrix never applies manual, requires auto decision, and gates yolo", () => {
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "manual", decisionApproved: true, allowlisted: true, releaseGatesPassed: true }), { allowed: false, reason: "manual-advisory-only" });
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "auto" }), { allowed: false, reason: "decision-required" });
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "auto", decisionApproved: true }), { allowed: true, reason: "explicit-decision" });
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "auto", decisionApproved: true, headless: true }), { allowed: true, reason: "explicit-decision" });
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "yolo", allowlisted: false, releaseGatesPassed: true }), { allowed: false, reason: "scope-not-allowlisted" });
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "yolo", allowlisted: true, releaseGatesPassed: false }), { allowed: false, reason: "release-gates-failed" });
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "yolo", allowlisted: true, releaseGatesPassed: true, headless: true }), { allowed: true, reason: "yolo-release-gates-passed" });
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "yolo", allowlisted: true, releaseGatesPassed: true, killSwitchActive: true }), { allowed: false, reason: "kill-switch" });
  assert.deepEqual(schemas.evaluateApplyAuthority({ mode: "corrupt", decisionApproved: true }), { allowed: false, reason: "manual-advisory-only" });
});

test("kill-switch downgrade disables in-flight yolo apply without rewriting stored preference", () => {
  const result = schemas.downgradeOnKillSwitch({
    storedMode: "yolo",
    effectiveMode: "yolo",
    yoloApplicationEnabled: true,
    killSwitchActive: false,
    actor: "runtime-kill-switch",
    timestamp: 500,
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.storedMode, "yolo");
  assert.equal(result.state.effectiveMode, "manual");
  assert.equal(result.state.yoloApplicationEnabled, false);
  assert.equal(result.events[0].kind, "kill-switch");

  const repeated = schemas.downgradeOnKillSwitch(result.state);
  assert.equal(repeated.ok, true);
  assert.deepEqual(repeated.events, []);
});

test("audit, rollback, and intervention records enforce bounded strings and hashes", () => {
  const audit = schemas.makeAuditEvent({ id: H("1"), kind: "apply", proposalId: "proposal-1", actor: "self-evolve-applier", timestamp: 10, payloadHash: H("2"), details: { mode: "yolo", count: 1 } });
  assert.equal(audit.kind, "apply");
  assert.throws(() => schemas.makeAuditEvent({ ...audit, kind: "shell" }), /invalid-enum/);
  assert.throws(() => schemas.makeAuditEvent({ ...audit, actor: "x".repeat(129) }), /out-of-bounds/);
  assert.throws(() => schemas.makeAuditEvent({ ...audit, details: { nested: {} } }), /bounded primitive/);

  const rollback = schemas.makeRollbackRecord({ proposalId: "proposal-1", appliedHash: PROPOSED, rolledBackAt: 20, reason: "verified current hash before rollback" });
  assert.equal(rollback.appliedHash, PROPOSED);
  assert.throws(() => schemas.makeRollbackRecord({ ...rollback, reason: "x".repeat(513) }), /out-of-bounds/);

  const epoch = schemas.makeInterventionEpoch({ epochId: "epoch-1", startedAt: 10, reason: "circuit breaker opened" });
  assert.equal(epoch.epochId, "epoch-1");
  assert.throws(() => schemas.makeInterventionEpoch({ ...epoch, epochId: "x".repeat(129) }), /out-of-bounds/);
});

test("synthesis outcome audits enforce exact terminal status and success semantics", () => {
  const event = schemas.makeSynthesisOutcomeAuditEvent({
    outcomeId: H("3"), projectFingerprint: PROJECT, clusterId: CLUSTER,
    status: "no-change", success: true, terminalAt: 300, reasonCode: "valid-no-change",
  });
  assert.deepEqual(schemas.parseSynthesisOutcomeAuditEvent(event), event.details);
  assert.throws(() => schemas.makeSynthesisOutcomeAuditEvent({
    outcomeId: H("4"), projectFingerprint: PROJECT, clusterId: CLUSTER,
    status: "failed", success: true, terminalAt: 300, reasonCode: "synthesis-failed",
  }), /invalid-synthesis-outcome-success/u);
  assert.equal(schemas.parseSynthesisOutcomeAuditEvent({ ...event, actor: "fixture" }), null);
  assert.equal(schemas.parseSynthesisOutcomeAuditEvent({ ...event, details: { ...event.details, extra: "ignored" } }), null);
});

test("circuit breaker trips, retrips, resets, and rejects inconsistent metadata", () => {
  const closed = schemas.makeCircuitBreaker({ open: false, tripCount: 0 });
  const opened = schemas.trip(closed, "three analyzer failures", 100);
  assert.deepEqual(opened, { open: true, openedAt: 100, reason: "three analyzer failures", tripCount: 1 });
  const retripped = schemas.trip(opened, "another failure", 200);
  assert.equal(retripped.tripCount, 2);
  assert.deepEqual(schemas.reset(retripped), { open: false, tripCount: 2 });
  assert.throws(() => schemas.makeCircuitBreaker({ open: true, tripCount: 1 }), /needs openedAt and reason/);
  assert.throws(() => schemas.makeCircuitBreaker({ open: false, openedAt: 1, reason: "stale", tripCount: 1 }), /cannot retain open metadata/);
  assert.throws(() => schemas.makeCircuitBreaker({ open: false, tripCount: -1 }), /out-of-bounds/);
});
