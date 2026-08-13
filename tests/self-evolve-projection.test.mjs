import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildUiProjection } from "../self-evolve-projection.js";
import {
  makeAuditEvent,
  makeCircuitBreaker,
  makeDecision,
  makeEligibilityExplanation,
  makeEvidenceCluster,
  makeGlobalSettings,
  makeProposal,
  makeProposalContent,
  wrapRecord,
} from "../self-evolve-schemas.js";
import { hashContent, openStore } from "../self-evolve-store.js";

const PROJECT = "a".repeat(64);
const ROOT_IDENTITY = "b".repeat(64);
const NOW = 4_000_000;
const CURRENT = "---\nname: demo\n---\n# Current\n";
const PROPOSED = "---\nname: demo\n---\n# Proposed\n";
const CURRENT_HASH = hashContent(CURRENT);
const PROPOSED_HASH = hashContent(PROPOSED);

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function fixture(t, { mode: _retiredMode = "auto" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-projection-"));
  const skillRoot = path.join(root, "skills");
  const skillPath = path.join(skillRoot, "demo", "SKILL.md");
  mkdirSync(path.dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, CURRENT);
  const store = openStore(root, { projectName: "projection", projectFingerprint: PROJECT, now: () => NOW });
  const current = store.getSettings();
  const legacyMetadata = store.setGlobalSettings(makeGlobalSettings({
    ...current.global,
    mode: current.global.mode,
    allowedSkillRoots: [skillRoot],
    updatedAt: NOW,
  }));
  assert.deepEqual(legacyMetadata.allowedSkillRoots, [skillRoot]);
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const targetReader = (proposal) => {
    const target = path.join(proposal.skillTarget.canonicalRoot, proposal.skillTarget.relativePath);
    if (!existsSync(target)) return { exists: false, content: null, hash: null };
    const content = readFileSync(target);
    return { exists: true, content, hash: hashContent(content) };
  };
  const inventory = () => {
    const content = readFileSync(skillPath);
    return [{
      canonicalRoot: skillRoot,
      relativePath: "demo/SKILL.md",
      exists: true,
      currentHash: hashContent(content),
    }];
  };
  return { root, skillRoot, skillPath, store, targetReader, inventory };
}

function proposal(skillRoot, overrides = {}) {
  return makeProposal({
    id: overrides.id ?? "proposal-1",
    projectFingerprint: overrides.projectFingerprint ?? PROJECT,
    clusterId: overrides.clusterId ?? hash(`cluster:${overrides.id ?? "proposal-1"}`),
    skillTarget: {
      canonicalRoot: skillRoot,
      relativePath: overrides.relativePath ?? "demo/SKILL.md",
      currentHash: overrides.currentHash ?? CURRENT_HASH,
    },
    proposedContentHash: overrides.proposedContentHash ?? PROPOSED_HASH,
    rationaleText: overrides.rationaleText ?? "Repeated deterministic evidence supports this bounded skill update.",
    synthesizedAt: overrides.synthesizedAt ?? NOW - 5_000,
    synthesizerModelId: "fixture/no-provider",
    criticScore: overrides.criticScore ?? 0.95,
    criticPassed: overrides.criticPassed ?? true,
    validDeterministic: overrides.validDeterministic ?? true,
    state: overrides.state ?? "pending",
    injectionFlagged: overrides.injectionFlagged ?? false,
    decisionVersion: overrides.decisionVersion ?? 0,
    burnedNonceHashes: overrides.burnedNonceHashes ?? [],
  });
}

function append(store, kind, payload, createdAt = NOW - 4_000) {
  const result = store.appendRecord(wrapRecord(kind, payload, createdAt));
  assert.equal(result.ok, true, `${kind}: ${result.reason}`);
}

function seedContent(store, item, content = PROPOSED, createdAt = NOW - 3_900) {
  append(store, "proposal-content", makeProposalContent({
    proposalId: item.id,
    contentHash: item.proposedContentHash,
    contentEncoding: "base64",
    chunkIndex: 0,
    chunkCount: 1,
    content: Buffer.from(content).toString("base64"),
  }), createdAt);
}

function audit(kind, proposalId, details, timestamp = NOW - 3_000) {
  return makeAuditEvent({
    id: hash(JSON.stringify([kind, proposalId, details, timestamp])),
    kind,
    ...(proposalId ? { proposalId } : {}),
    actor: "self-evolve-integration",
    timestamp,
    payloadHash: hash(JSON.stringify(details)),
    details,
  });
}

function seedLegacyGrant(store, item, expiresAt = NOW + 30_000) {
  append(store, "audit-event", audit("decision", item.id, {
    action: "bridge-nonce",
    projectFingerprint: item.projectFingerprint,
    subjectId: item.id,
    targetHash: item.skillTarget.currentHash,
    proposedContentHash: item.proposedContentHash,
    decisionVersion: item.decisionVersion + 1,
    priorState: item.state,
    actor: "self-evolve-tui",
    nonce: hash(`legacy:${item.id}`),
    expiresAt,
  }));
}

function seedEvidence(store, item) {
  append(store, "evidence-cluster", makeEvidenceCluster({
    id: item.clusterId,
    receiptType: "repeated-command",
    projectFingerprint: PROJECT,
    incidentIds: ["incident-1", "incident-2", "incident-3"],
    scopeFingerprint: hash("scope"),
    occurrencesSum: 4,
    firstSeenAt: NOW - 20_000,
    lastSeenAt: NOW - 2_000,
  }));
  append(store, "eligibility-explanation", makeEligibilityExplanation({
    clusterId: item.clusterId,
    eligible: true,
    reasons: ["all-thresholds-met"],
    thresholdsMet: {
      minIndependentIncidents: "3 (actual 3)",
      minOccurrencesSum: "3 (actual 4)",
    },
    thresholdsMissed: {},
  }));
}

function build(f, options = {}) {
  return buildUiProjection(f.store.readProjectionSnapshot(), {
    stateRootIdentity: ROOT_IDENTITY,
    now: NOW,
    targetReader: f.targetReader,
    inventory: f.inventory(),
    ...options,
  });
}

test("fresh projection starts Automatic recommendations On with the required permission bundle", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-projection-first-run-"));
  const store = openStore(root, {
    projectName: "projection-first-run",
    projectFingerprint: PROJECT,
    now: () => NOW,
  });
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const project = (snapshot) => buildUiProjection(snapshot, {
    stateRootIdentity: ROOT_IDENTITY,
    now: NOW,
    targetReader: () => ({ exists: false, content: null, hash: null }),
    inventory: [],
  });

  const first = project(store.readProjectionSnapshot());
  assert.deepEqual(first.dashboard.blockers, []);
  assert.equal(first.index.status.automaticRecommendationsEnabled, true);
  assert.equal(first.dashboard.settings.automaticRecommendationsEnabled, true);
  assert.deepEqual(first.dashboard.settings.consent, {
    durableObservations: true,
    sanitizedExcerpts: true,
    crossRepoAggregation: true,
  });
});

test("dashboard retention derives operational records from the configured store policy", (t) => {
  const f = fixture(t);
  for (const [retentionDays, operationalDays] of [[1, 3], [10, 30], [30, 90], [3_650, 10_950]]) {
    const current = f.store.getSettings();
    assert.equal(f.store.setGlobalSettings(makeGlobalSettings({
      ...current.global,
      retentionDays,
      updatedAt: current.global.updatedAt + 1,
    })).retentionDays, retentionDays);
    assert.deepEqual(build(f).dashboard.retention, {
      observationsDays: retentionDays,
      operationalDays,
    });
  }
});

test("creation-policy suggestions do not gate Automatic recommendations", (t) => {
  const f = fixture(t);
  const current = f.store.getSettings();
  const changed = f.store.setGlobalSettings(makeGlobalSettings({
    ...current.global,
    allowedSkillRoots: [],
    updatedAt: NOW + 1,
  }));
  assert.deepEqual(changed.allowedSkillRoots, []);
  const result = build(f);
  assert.equal(result.dashboard.settings.automaticRecommendationsEnabled, true);
  assert.equal(result.dashboard.blockers.some((blocker) => blocker.code === "approved-skill-folders"), false);
});

function treeSnapshot(root) {
  const output = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const filePath = path.join(directory, name);
      const relative = path.relative(root, filePath);
      const stat = statSync(filePath);
      if (stat.isDirectory()) visit(filePath);
      else output.push([relative, stat.mode & 0o777, hash(readFileSync(filePath))]);
    }
  };
  visit(root);
  return output;
}

test("pending projections render bounded diff, evidence, eligibility, budgets, and fresh legacy actions", (t) => {
  const f = fixture(t);
  const item = proposal(f.skillRoot);
  append(f.store, "proposal", item);
  seedContent(f.store, item);
  seedEvidence(f.store, item);
  seedLegacyGrant(f.store, item);

  const result = build(f, { detailProposalIds: [item.id] });
  assert.equal(result.index.status.state, "ready");
  assert.equal(result.index.status.automaticRecommendationsEnabled, true);
  assert.equal(result.dashboard.indexHash, result.index.projectionHash);
  assert.equal(result.dashboard.generation, result.index.generation);
  assert.equal(result.dashboard.automation.state, "ready");
  assert.equal(result.dashboard.settings.automaticRecommendationsEnabled, true);
  assert.equal(result.dashboard.usage.storage.usedBytes > 0, true);
  assert.equal(result.index.capabilities.includes("control-repo-mode-v1"), false);
  assert.equal(result.dashboard.capabilities.includes("control-repo-mode-v1"), false);
  assert.equal(result.dashboard.supportedControls.includes("set-repo-mode"), false);
  assert.equal(result.index.reviews.length, 1);
  assert.equal(result.details.length, 1);
  assert.equal(result.publicationDetails.length, 1);
  assert.equal(result.publicationDetails[0].detailHash, result.index.reviews[0].detailHash);
  const detail = result.details[0];
  assert.equal(detail.detailHash, result.index.reviews[0].detailHash);
  assert.equal(detail.revision, result.index.reviews[0].detailRevision);
  assert.equal(detail.summary.tokenImpact.estimatedTokens, Math.ceil(Buffer.byteLength(PROPOSED) / 4));
  assert.equal(detail.summary.tokenImpact.budgetTokens, 24_576);
  assert.equal(detail.summary.eligibility.eligible, true);
  assert.deepEqual(detail.summary.eligibility.checks.map((check) => check.name), [
    "minIndependentIncidents",
    "minOccurrencesSum",
  ]);
  assert.deepEqual(detail.evidence.map((entry) => entry.kind), ["repeated-command"]);
  assert.equal(detail.evidence.every((entry) => entry.redacted), true);
  assert.equal(detail.diff.kind, "unified");
  assert.match(detail.diff.lines.join("\n"), /-# Current[\s\S]*\+# Proposed/u);
  assert.deepEqual(detail.allowedActions.map((action) => action.action), ["apply-proposal", "reject-proposal"]);
  assert.equal(result.index.generation, result.generation);
  assert.equal(result.unavailableDetailIds.length, 0);
});

test("critic-pending stays internal until one pending review is published, while failure uses the critical surface", (t) => {
  const f = fixture(t);
  const draft = proposal(f.skillRoot, {
    id: "critic-draft",
    state: "critic-pending",
    criticScore: 0,
    criticPassed: false,
  });
  append(f.store, "proposal", draft);
  seedContent(f.store, draft);
  const hidden = build(f, { detailProposalIds: [draft.id] });

  assert.deepEqual(hidden.index.reviews, []);
  assert.deepEqual(hidden.publicationDetails, []);
  assert.deepEqual(hidden.details, []);
  assert.deepEqual(hidden.unavailableDetailIds, []);
  assert.doesNotMatch(JSON.stringify(hidden), /critic-draft/u);
  assert.equal(f.store.readRecords("proposal").at(-1).payload.state, "critic-pending");

  append(f.store, "proposal", { ...draft, state: "pending", criticScore: 0.95, criticPassed: true, decisionVersion: 1 });
  const revealed = build(f, { detailProposalIds: [draft.id] });
  assert.deepEqual(revealed.index.reviews.map((review) => review.proposalId), [draft.id]);
  assert.deepEqual(revealed.publicationDetails.map((detail) => detail.proposalId), [draft.id]);
  assert.deepEqual(revealed.details.map((detail) => detail.proposalId), [draft.id]);

  append(f.store, "proposal", { ...draft, state: "failed-closed", decisionVersion: 1 });
  const failed = build(f, { detailProposalIds: [draft.id] });
  assert.deepEqual(failed.index.reviews.map((review) => [review.proposalId, review.attention]), [
    [draft.id, "critical"],
  ]);
  assert.deepEqual(failed.details[0].allowedActions, []);
});

test("existing explicit proposal actions remain available while automation is Off", (t) => {
  const f = fixture(t);
  const item = proposal(f.skillRoot, { id: "proposal-off" });
  append(f.store, "proposal", item);
  seedContent(f.store, item);
  seedLegacyGrant(f.store, item);
  const automation = f.store.getAutomationState();
  assert.equal(f.store.transitionAutomation({
    transitionId: "projection-off",
    expectedGeneration: automation.epoch.generation,
    action: "set-automatic-recommendations",
    enabled: false,
  }).ok, true);
  const result = build(f, { detailProposalIds: [item.id] });
  assert.equal(result.dashboard.settings.automaticRecommendationsEnabled, false);
  assert.deepEqual(result.details[0].allowedActions.map((action) => action.action), ["apply-proposal", "reject-proposal"]);
});

test("failed-closed review stays critical and actionless while the current dashboard is healthy", (t) => {
  const f = fixture(t);
  const pending = proposal(f.skillRoot, { id: "failed-healthy-dashboard" });
  append(f.store, "proposal", pending);
  seedContent(f.store, pending);
  const failed = { ...pending, state: "failed-closed", decisionVersion: 1 };
  append(f.store, "proposal", failed);
  seedLegacyGrant(f.store, failed);

  const result = build(f, { detailProposalIds: [failed.id] });
  assert.equal(result.dashboard.automation.state, "ready");
  assert.deepEqual(result.index.reviews.map((review) => [review.state, review.attention]), [
    ["failed-closed", "critical"],
  ]);
  assert.deepEqual(result.details[0].allowedActions, []);
  assert.equal(Buffer.byteLength(result.details[0].summary.rationale, "utf8") <= 2 * 1_024, true);
});

test("applied audit projections expose verified rollback eligibility and local acknowledgement only", (t) => {
  const f = fixture(t);
  writeFileSync(f.skillPath, PROPOSED);
  const item = proposal(f.skillRoot, { state: "applied", decisionVersion: 2 });
  append(f.store, "proposal", item);
  seedContent(f.store, item);
  append(f.store, "audit-event", audit("apply", item.id, {
    state: "readback-verified",
    appliedHash: PROPOSED_HASH,
    "readback-verified": true,
  }));
  const result = build(f, { detailProposalIds: [item.id] });
  const detail = result.details[0];
  assert.deepEqual(detail.summary.rollback, { eligible: true, reason: null, appliedHash: PROPOSED_HASH });
  assert.deepEqual(detail.allowedActions.map((action) => action.action), ["acknowledge-audit"]);
  assert.match(detail.audit[0].summary, /readback was verified/u);
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(f.skillRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("missing content, failed-closed state, target drift, and private material fail closed without state changes", (t) => {
  const f = fixture(t);
  const failed = proposal(f.skillRoot, {
    id: "failed",
    state: "failed-closed",
    proposedContentHash: hash("missing"),
    rationaleText: "private ses_super_secret_session should never render",
  });
  append(f.store, "proposal", failed);
  const drifted = proposal(f.skillRoot, { id: "drifted", relativePath: "demo/SKILL.md" });
  append(f.store, "proposal", drifted);
  seedContent(f.store, drifted, PROPOSED);
  writeFileSync(f.skillPath, `${CURRENT}drift\n`);
  // Settle the one-time v0.3 metadata mirror before proving that projection
  // construction itself is read-only.
  f.store.readProjectionSnapshot();
  const beforeRecords = f.store.readRecords("proposal").map((record) => record.id);
  const beforeTree = treeSnapshot(f.root);
  const result = build(f, { detailProposalIds: [failed.id, drifted.id] });
  const afterTree = treeSnapshot(f.root);
  assert.deepEqual(f.store.readRecords("proposal").map((record) => record.id), beforeRecords);
  assert.deepEqual(afterTree, beforeTree);
  for (const detail of result.details) {
    assert.equal(detail.summary.risk, "critical");
    assert.equal(detail.diff.kind, "unavailable");
    assert.deepEqual(detail.allowedActions, []);
  }
  assert.doesNotMatch(JSON.stringify(result), /ses_super_secret_session/u);
  assert.equal(result.index.reviews.every((review) => review.attention === "critical"), true);
});

test("schema-valid proposal chunks with inconsistent decoded content are never rendered or actionable", (t) => {
  const f = fixture(t);
  const item = proposal(f.skillRoot, { id: "inconsistent-content" });
  append(f.store, "proposal", item);
  seedContent(f.store, item, "different bytes with a falsely claimed hash");
  seedLegacyGrant(f.store, item);
  const result = build(f, { detailProposalIds: [item.id] });
  const detail = result.details[0];
  assert.equal(detail.summary.risk, "critical");
  assert.equal(detail.diff.kind, "unavailable");
  assert.deepEqual(detail.allowedActions, []);
  assert.doesNotMatch(JSON.stringify(result), /different bytes/u);
});

test("corrupt, terminal, startup, and unavailable health states are explicit and suppress global actions", (t) => {
  const f = fixture(t);
  for (const state of ["corrupt", "terminal", "startup-pending", "unavailable"]) {
    const result = build(f, { health: { state, reason: `${state}-fixture` } });
    assert.equal(result.index.status.state, state);
    assert.equal(result.index.status.reason, `${state}-fixture`);
    assert.deepEqual(result.index.allowedActions, []);
  }
});

test("Automatic recommendations reports when the lifecycle hook awaits restart", (t) => {
  const f = fixture(t);
  const result = build(f, { health: { lifecycleEventHookInstalled: false } });
  assert.equal(result.index.status.state, "setup-required");
  assert.equal(result.index.status.reason, "restart-required");
  assert.deepEqual(
    result.dashboard.blockers.filter((blocker) => blocker.code === "restart-required"),
    [{
      code: "restart-required",
      summary: "Background analysis is awaiting an OpenCode restart before it can activate.",
      destination: "settings",
    }],
  );
});

test("project exclusion is an operational suppressor that does not rewrite preference", (t) => {
  const f = fixture(t);
  assert.equal(f.store.setAutomationProjectExcluded(true).ok, true);
  let result = build(f);
  assert.equal(result.index.status.automaticRecommendationsEnabled, true);
  assert.equal(result.dashboard.settings.automaticRecommendationsEnabled, true);
  assert.equal(result.dashboard.automation.state, "excluded");

  assert.equal(f.store.setAutomationProjectExcluded(false).ok, true);
  result = build(f);
  assert.equal(result.index.status.automaticRecommendationsEnabled, true);
  assert.equal(result.dashboard.automation.state, "ready");
});

test("operation grants bind the exact project, root, and target-derived generation without circular store hashes", (t) => {
  const f = fixture(t);
  const item = proposal(f.skillRoot);
  append(f.store, "proposal", item);
  seedContent(f.store, item);
  const firstSnapshot = f.store.readProjectionSnapshot();
  const first = buildUiProjection(firstSnapshot, {
    stateRootIdentity: ROOT_IDENTITY,
    now: NOW,
    targetReader: f.targetReader,
    inventory: f.inventory(),
  });
  assert.equal(first.dashboard.settings.globalRootPolicy, null);
  assert.match(first.dashboard.settings.globalRootPolicyConfirmation, /^REPLACE GLOBAL ROOT POLICY [a-f0-9]{12}$/u);
  assert.equal(first.dashboard.settings.globalRootPolicyAction, null);
  append(f.store, "audit-event", audit("decision", item.id, {
    action: "ui-operation-nonce",
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT_IDENTITY,
    generation: first.generation,
    subjectId: item.id,
    uiAction: "snooze-proposal",
    capability: "operation-snooze-v1",
    nonce: hash("snooze"),
    expiresAt: NOW + 30_000,
  }));
  const secondSnapshot = f.store.readProjectionSnapshot();
  assert.equal(secondSnapshot.generation, firstSnapshot.generation);
  const second = buildUiProjection(secondSnapshot, {
    stateRootIdentity: ROOT_IDENTITY,
    now: NOW,
    targetReader: f.targetReader,
    inventory: f.inventory(),
    detailProposalIds: [item.id],
  });
  assert.equal(second.generation, first.generation);
  assert.deepEqual(second.details[0].allowedActions.map((action) => action.action), ["snooze-proposal"]);

  append(f.store, "audit-event", audit("decision", null, {
    action: "ui-operation-nonce",
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT_IDENTITY,
    generation: second.generation,
    uiAction: "set-automatic-recommendations",
    capability: "automatic-recommendations-control-v1",
    nonce: hash("automation"),
    expiresAt: NOW + 30_000,
  }, NOW - 2_000));
  append(f.store, "audit-event", audit("decision", null, {
    action: "ui-operation-nonce",
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT_IDENTITY,
    generation: second.generation,
    uiAction: "replace-global-root-policy",
    capability: "operation-global-root-policy-v1",
    nonce: hash("root-policy"),
    expiresAt: NOW + 30_000,
  }, NOW - 1_950));
  append(f.store, "audit-event", audit("decision", null, {
    action: "ui-operation-nonce",
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT_IDENTITY,
    generation: second.generation,
    uiAction: "retry-bootstrap",
    capability: "operation-retry-bootstrap-v1",
    nonce: hash("retry"),
    expiresAt: NOW + 30_000,
  }, NOW - 1_900));
  const third = build(f);
  assert.deepEqual(third.index.allowedActions.map((action) => action.action), ["set-automatic-recommendations"]);
  assert.equal(third.dashboard.settings.globalRootPolicyAction.action, "replace-global-root-policy");
});

test("dashboard activity is allowlisted and usage-only audits do not churn the core generation", (t) => {
  const f = fixture(t);
  const item = proposal(f.skillRoot);
  append(f.store, "proposal", item);
  seedContent(f.store, item);
  const firstSnapshot = f.store.readProjectionSnapshot();
  const first = build(f);

  append(f.store, "audit-event", makeAuditEvent({
    id: hash("passive-budget"),
    kind: "decision",
    actor: "self-evolve-scheduler",
    timestamp: NOW - 500,
    payloadHash: hash("passive-budget-payload"),
    details: {
      action: "scheduler-budget",
      budgetType: "passive",
      reservationId: hash("reservation"),
      slotIndex: 0,
      slotCount: 1,
      rootSessionIDHash: hash("root-session"),
    },
  }), NOW - 500);
  append(f.store, "audit-event", makeAuditEvent({
    id: hash("passive-budget-window-boundary"),
    kind: "decision",
    actor: "self-evolve-scheduler",
    timestamp: NOW - 60 * 60 * 1000,
    payloadHash: hash("passive-budget-window-boundary-payload"),
    details: {
      action: "scheduler-budget",
      budgetType: "passive",
      reservationId: hash("boundary-reservation"),
      slotIndex: 0,
      slotCount: 1,
      rootSessionIDHash: hash("boundary-root-session"),
    },
  }), NOW - 60 * 60 * 1000);
  const usageSnapshot = f.store.readProjectionSnapshot();
  assert.equal(usageSnapshot.generation, firstSnapshot.generation);
  assert.equal(usageSnapshot.usage.provider.used, 2);
  assert.equal(usageSnapshot.usage.provider.remaining, 4);
  assert.equal(usageSnapshot.usage.provider.resetAt, NOW);

  append(f.store, "audit-event", audit("decision", item.id, {
    action: "cycle-outcome",
    outcome: "valid-no-change",
    triggerClass: "idle",
    observationCount: 3,
    eligibilityCount: 1,
    occurredAt: NOW - 400,
    reason: "no-change",
  }, NOW - 400));
  append(f.store, "audit-event", audit("decision", null, {
    action: "arbitrary-private-audit",
    detail: "secret-value ses_private_session",
  }, NOW - 300));
  const second = build(f);
  assert.equal(second.dashboard.usage.provider.used, 2);
  assert.notEqual(second.dashboard.dashboardHash, first.dashboard.dashboardHash);
  assert.equal(second.dashboard.lastCycle.outcome, "valid-no-change");
  assert.deepEqual(second.dashboard.activity.map((entry) => entry.outcome), ["valid-no-change"]);
  assert.doesNotMatch(JSON.stringify(second.dashboard), /secret-value|ses_private_session|root-session/u);
});

test("dashboard activity narrates lifecycle, controls, maintenance, recovery, and failures without raw audit detail", (t) => {
  const f = fixture(t);
  const item = proposal(f.skillRoot);
  append(f.store, "proposal", item);
  seedContent(f.store, item);
  append(f.store, "decision", makeDecision({
    proposalId: item.id,
    targetHash: item.skillTarget.currentHash,
    proposedContentHash: item.proposedContentHash,
    decisionVersion: 1,
    actor: "self-evolve-tui",
    timestamp: NOW - 1_900,
    nonce: hash("semantic-approval"),
    priorState: "pending",
    newState: "approved",
  }), NOW - 1_900);
  const events = [
    audit("decision", item.id, {
      action: "cycle-outcome",
      outcome: "not-eligible",
      triggerClass: "idle",
      observationCount: 3,
      eligibilityCount: 0,
      occurredAt: NOW - 1_850,
      reason: "insufficient-evidence",
    }, NOW - 1_850),
    audit("decision", item.id, {
      action: "snooze",
      snoozedUntil: NOW + 60_000,
      privatePath: "/never/projected/private/SKILL.md",
    }, NOW - 1_800),
    audit("mode-change", null, { action: "automation-control", control: "set-automatic-recommendations", enabled: false, privateSession: "ses_private" }, NOW - 1_700),
    audit("mode-change", null, { action: "automation-control", control: "set-automatic-recommendations", enabled: true }, NOW - 1_600),
    audit("mode-change", null, { action: "exclude" }, NOW - 1_500),
    audit("mode-change", null, { action: "include" }, NOW - 1_400),
    audit("kill-switch", null, { action: "on" }, NOW - 1_300),
    audit("kill-switch", null, { action: "off" }, NOW - 1_200),
    audit("decision", null, {
      action: "ui-operation-complete",
      uiAction: "export-data",
      accepted: true,
      privateArtifactPath: "/never/projected/export.json",
    }, NOW - 1_100),
    audit("decision", null, {
      action: "ui-operation-complete",
      uiAction: "purge-scope",
      accepted: true,
    }, NOW - 1_000),
    audit("decision", null, {
      action: "ui-operation-complete",
      uiAction: "purge-all",
      accepted: true,
    }, NOW - 900),
    audit("decision", null, {
      action: "boot",
      hostVersion: "1.18.3",
      recovered: 0,
    }, NOW - 800),
    audit("decision", null, {
      action: "boot",
      hostVersion: "1.18.3",
      recovered: 2,
    }, NOW - 700),
    audit("apply", item.id, {
      "readback-verified": true,
      privateBackupPath: "/never/projected/backup",
    }, NOW - 650),
    audit("rollback", item.id, {
      "readback-verified": true,
      privateBackupPath: "/never/projected/backup",
    }, NOW - 625),
  ];
  for (const event of events) append(f.store, "audit-event", event, event.timestamp);
  for (const [reason, timestamp] of [
    ["quiet-period", NOW - 610],
    ["budget-exhausted", NOW - 605],
  ]) {
    const details = { action: "schedule-suppressed", reason };
    append(f.store, "audit-event", makeAuditEvent({
      id: hash(JSON.stringify(["scheduler", details, timestamp])),
      kind: "decision",
      actor: "self-evolve-scheduler",
      timestamp,
      payloadHash: hash(JSON.stringify(details)),
      details,
    }), timestamp);
  }
  const failureDetails = {
    action: "work-failure",
    backoffUntil: NOW + 30_000,
    privateError: "token=never-project-this",
  };
  append(f.store, "audit-event", makeAuditEvent({
    id: hash(JSON.stringify(["scheduler", failureDetails])),
    kind: "decision",
    actor: "self-evolve-scheduler",
    timestamp: NOW - 601,
    payloadHash: hash(JSON.stringify(failureDetails)),
    details: failureDetails,
  }), NOW - 601);
  append(f.store, "circuit-breaker", makeCircuitBreaker({
    open: true,
    openedAt: NOW - 600,
    reason: "three bounded failures",
    tripCount: 3,
  }), NOW - 600);
  append(f.store, "circuit-breaker", makeCircuitBreaker({
    open: false,
    tripCount: 3,
  }), NOW - 590);

  const result = build(f);
  const outcomes = new Set(result.dashboard.activity.map((entry) => entry.outcome));
  for (const outcome of [
    "recommendation-approved",
    "recommendation-snoozed",
    "not-eligible",
    "applied",
    "rolled-back",
    "deferred",
    "failed",
    "automatic-recommendations-off",
    "automatic-recommendations-on",
    "project-excluded",
    "project-included",
    "emergency-stop-enabled",
    "emergency-stop-disabled",
    "export-completed",
    "purge-completed",
    "purge-all-accepted",
    "bootstrap-completed",
    "recovery-completed",
    "breaker-open",
    "breaker-recovered",
  ]) assert.equal(outcomes.has(outcome), true, `missing semantic outcome ${outcome}`);
  for (const entry of result.dashboard.activity) {
    assert.match(entry.summary, /\S/u);
    assert.equal(typeof entry.occurredAt, "number");
  }
  assert.doesNotMatch(
    JSON.stringify(result.dashboard.activity),
    /never\/projected|ses_private|token=|privateArtifactPath|privateSession|privatePath|privateError/u,
  );
});

test("semantic proposal IDs redact legacy session/message IDs and malformed records", (t) => {
  const f = fixture(t);
  const events = [
    audit("decision", "proposal-logical-1", {
      action: "cycle-outcome",
      outcome: "valid-no-change",
      triggerClass: "manual",
      mode: "manual",
      observationCount: 1,
      eligibilityCount: 0,
      occurredAt: NOW - 500,
      reason: "no-change",
    }, NOW - 500),
    audit("apply", "ses_legacy", { "readback-verified": true }, NOW - 400),
    audit("rollback", "session_legacy", { "readback-verified": true }, NOW - 300),
    audit("decision", "msg_legacy", { action: "snooze", snoozedUntil: NOW + 10_000 }, NOW - 200),
    audit("apply", "message_legacy", { "readback-verified": true }, NOW - 100),
  ];
  for (const event of events) append(f.store, "audit-event", event, event.timestamp);

  const snapshot = f.store.readProjectionSnapshot();
  const corruptEvent = {
    ...audit("rollback", "proposal-placeholder", { "readback-verified": true }, NOW - 50),
    proposalId: { legacy: "ses_corrupt" },
  };
  const corruptSnapshot = {
    ...snapshot,
    records: [...snapshot.records, {
      id: hash("corrupt-legacy-record"),
      kind: "audit-event",
      createdAt: corruptEvent.timestamp,
      payload: corruptEvent,
    }],
  };
  const result = buildUiProjection(corruptSnapshot, {
    stateRootIdentity: ROOT_IDENTITY,
    now: NOW,
    targetReader: f.targetReader,
    inventory: f.inventory(),
  });
  const recommendationActivity = result.dashboard.activity
    .filter((entry) => entry.category === "recommendation");

  assert.equal(result.dashboard.lastCycle.proposalId, "proposal-logical-1");
  assert.equal(recommendationActivity.length, 5);
  assert.equal(recommendationActivity.every((entry) => entry.proposalId === null), true);
  assert.doesNotMatch(
    JSON.stringify(result.dashboard),
    /(?:ses|session|msg|message)_(?:legacy|corrupt)/u,
  );
});

test("private semantic proposal IDs never enter index or detail serialization", (t) => {
  const f = fixture(t);
  const logical = proposal(f.skillRoot, { id: "proposal-logical-1" });
  const legacy = proposal(f.skillRoot, { id: "session_legacy_proposal" });
  append(f.store, "proposal", logical);
  seedContent(f.store, logical);
  append(f.store, "proposal", legacy);
  seedContent(f.store, legacy);

  const result = build(f, { detailProposalIds: [logical.id, legacy.id] });
  assert.deepEqual(result.index.reviews.map((review) => review.proposalId), [logical.id]);
  assert.deepEqual(result.details.map((detail) => detail.proposalId), [logical.id]);
  assert.doesNotMatch(JSON.stringify(result.index), /session_legacy_proposal/u);
  assert.doesNotMatch(JSON.stringify(result.details), /session_legacy_proposal/u);
});

test("index bounds are deterministic, report exact overflow, and filter cross-project records", (t) => {
  const f = fixture(t);
  const targetValues = new Map();
  const inventory = [];
  const currentSettings = f.store.getSettings();
  assert.equal(f.store.setGlobalSettings(makeGlobalSettings({
    ...currentSettings.global,
    allowedSkillRoots: ["/skills"],
    updatedAt: NOW + 1,
  })).allowedSkillRoots[0], "/skills");
  for (let index = 0; index < 65; index += 1) {
    const id = `proposal-${String(index).padStart(2, "0")}`;
    const current = `current-${index}`;
    const proposed = `proposed-${index}`;
    const item = proposal("/skills", {
      id,
      relativePath: `${id}/SKILL.md`,
      currentHash: hashContent(current),
      proposedContentHash: hashContent(proposed),
      synthesizedAt: NOW - index,
    });
    append(f.store, "proposal", item, NOW - index);
    seedContent(f.store, item, proposed, NOW - index);
    targetValues.set(id, { exists: true, content: current, hash: hashContent(current) });
    inventory.push({
      canonicalRoot: "/skills",
      relativePath: `${id}/SKILL.md`,
      exists: true,
      currentHash: hashContent(current),
    });
  }
  const foreign = proposal("/skills", {
    id: "foreign",
    projectFingerprint: "f".repeat(64),
    relativePath: "foreign/SKILL.md",
    currentHash: hashContent("foreign"),
    proposedContentHash: hashContent("foreign-proposed"),
  });
  append(f.store, "proposal", foreign);
  const snapshot = f.store.readProjectionSnapshot();
  const result = buildUiProjection(snapshot, {
    stateRootIdentity: ROOT_IDENTITY,
    now: NOW,
    targetReader: (item) => targetValues.get(item.id),
    inventory,
  });
  assert.equal(result.index.reviews.length, 64);
  assert.equal(result.publicationDetails.length, 64);
  assert.deepEqual(
    result.publicationDetails.map((detail) => detail.proposalId),
    result.index.reviews.map((review) => review.proposalId),
  );
  assert.equal(result.index.overflow.reviews.truncated, true);
  assert.equal(result.index.overflow.reviews.omittedCount, 1);
  assert.equal(result.index.overflow.reviews.omittedBytes > 0, true);
  assert.equal(result.index.reviews.some((review) => review.proposalId === "foreign"), false);
});

test("target changes during construction abort the entire generation", (t) => {
  const f = fixture(t);
  const item = proposal(f.skillRoot);
  append(f.store, "proposal", item);
  seedContent(f.store, item);
  let reads = 0;
  assert.throws(() => buildUiProjection(f.store.readProjectionSnapshot(), {
    stateRootIdentity: ROOT_IDENTITY,
    now: NOW,
    targetReader: () => {
      reads += 1;
      const content = reads === 1 ? CURRENT : `${CURRENT}changed\n`;
      return { exists: true, content, hash: hashContent(content) };
    },
    inventory: f.inventory(),
  }), /target-content-changed-during-projection/u);
});

test("store projection snapshots are immutable, generation-stable for reads, and change with authority state", (t) => {
  const f = fixture(t);
  const first = f.store.readProjectionSnapshot();
  const second = f.store.readProjectionSnapshot();
  assert.equal(first.generation, second.generation);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.records), true);
  const item = proposal(f.skillRoot);
  append(f.store, "proposal", item);
  const third = f.store.readProjectionSnapshot();
  assert.notEqual(third.generation, first.generation);
  assert.equal(third.records.some((record) => record.kind === "proposal" && record.payload.id === item.id), true);
});
