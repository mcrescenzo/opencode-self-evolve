import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SCHEMA_VERSION,
  makeAuditEvent,
  makeDecision,
  makeObservation,
  makeProposal,
  wrapRecord,
} from "../self-evolve-schemas.js";
import {
  hashContent,
  migrate,
  openStore,
  projectFingerprintFor,
} from "../self-evolve-store.js";

const H = (character) => character.repeat(64);
const PROJECT = H("a");
const SCOPE = H("b");
const CURRENT = H("c");
const PROPOSED = H("d");
const CLUSTER = H("e");

function fixture(now = 1_000) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-store-"));
  return { root, store: openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => now }) };
}

function observation(createdAt = 1_000, id = H("1")) {
  return makeObservation({
    id,
    projectFingerprint: PROJECT,
    receiptIds: [H("2")],
    structuredFields: { receiptType: "repeated-command", scopeFingerprint: SCOPE, occurrences: 2 },
    incidentId: `incident-${id[0]}`,
    createdAt,
    injectionFlagged: false,
    redacted: true,
  });
}

function proposal(state = "pending", decisionVersion = 0) {
  return makeProposal({
    id: "proposal-1",
    projectFingerprint: PROJECT,
    clusterId: CLUSTER,
    skillTarget: { canonicalRoot: "/skills", relativePath: "review/SKILL.md", currentHash: CURRENT },
    proposedContentHash: PROPOSED,
    rationaleText: "Repeated deterministic evidence supports this bounded skill change.",
    synthesizedAt: 1_000,
    synthesizerModelId: "mock/model",
    criticScore: 0.95,
    criticPassed: true,
    validDeterministic: true,
    state,
    injectionFlagged: false,
    decisionVersion,
  });
}

function decision() {
  return makeDecision({
    proposalId: "proposal-1",
    targetHash: CURRENT,
    proposedContentHash: PROPOSED,
    decisionVersion: 1,
    actor: "human-reviewer",
    timestamp: 1_100,
    nonce: "decision-1",
    priorState: "pending",
    newState: "approved",
  });
}

function auditEnvelope(state, timestamp = 1_000) {
  const details = { state, target: "review/SKILL.md" };
  const event = makeAuditEvent({
    id: hashContent(`${state}:${timestamp}`),
    kind: "apply",
    proposalId: "proposal-1",
    actor: "self-evolve-applier",
    timestamp,
    payloadHash: hashContent(JSON.stringify(details)),
    details,
  });
  return wrapRecord("audit-event", event, timestamp);
}

test("creates the store atomically and appends and reads records", () => {
  const { root, store } = fixture();
  const envelope = wrapRecord("observation", observation(), 1_000);
  const result = store.appendRecord(envelope);

  assert.equal(result.ok, true);
  assert.deepEqual(store.readRecords("observation"), [envelope]);
  assert.deepEqual(store.getRecord("observation", envelope.id), envelope);
  assert.equal(store.getSettings().global.mode, "manual");

  const base = path.join(root, "self-evolve");
  const state = path.join(base, PROJECT);
  assert.equal(JSON.parse(readFileSync(path.join(base, "version.json"), "utf8")).schemaVersion, SCHEMA_VERSION);
  assert.equal(readdirSync(state).some((name) => name.endsWith(".tmp")), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(state, "observations.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(state, "settings.json")).mode & 0o777, 0o600);
  }
  store.close();
});

test("duplicate envelope IDs are idempotent", () => {
  const { store } = fixture();
  const envelope = wrapRecord("observation", observation(), 1_000);

  assert.equal(store.appendRecord(envelope).duplicate, false);
  assert.equal(store.appendRecord(envelope).duplicate, true);
  assert.equal(store.readRecords("observation").length, 1);
  store.close();
});

test("compare-and-swap appends a new version and rejects stale state", () => {
  const { store } = fixture();
  store.appendRecord(wrapRecord("proposal", proposal(), 1_000));

  const changed = store.runCas("proposal", "proposal-1", "pending", (current) => ({
    ...current,
    state: "approved",
    decisionVersion: 1,
  }));
  assert.equal(changed.ok, true);
  assert.equal(changed.newRecord.payload.state, "approved");
  assert.equal(store.readRecords("proposal").length, 2);
  assert.deepEqual(store.runCas("proposal", "proposal-1", "pending", (current) => current), {
    ok: false,
    reason: "stale-prior-state",
  });
  assert.equal(store.readRecords("audit-event").some((record) => record.payload.details.action === "cas"), true);
  store.close();
});

test("leases are create-exclusive, nonce-bound, releasable, and stale-cleaning", () => {
  let now = 1_000;
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-store-"));
  const first = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => now });
  const second = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => now });

  const acquired = first.acquireLease("target", { ttlMs: 100, actor: "first" });
  assert.equal(acquired.ok, true);
  assert.deepEqual(second.acquireLease("target", { ttlMs: 100, actor: "second" }), {
    ok: false,
    reason: "lease-busy",
    currentOwner: "first",
  });
  assert.deepEqual(first.releaseLease("target", "wrong"), { ok: false, reason: "nonce-mismatch" });
  assert.equal(first.isLeaseHeld("target", 1_050), true);
  assert.deepEqual(first.releaseLease("target", acquired.nonce), { ok: true });

  const expiring = first.acquireLease("target", { ttlMs: 100, actor: "first" });
  assert.equal(expiring.ok, true);
  now = 1_101;
  assert.equal(second.isLeaseHeld("target", now), false);
  const reacquired = second.acquireLease("target", { ttlMs: 100, actor: "second" });
  assert.equal(reacquired.ok, true);
  first.close();
  second.close();
});

test("retention removes old observations and preserves proposals, decisions, and audit", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const { store } = fixture(now);
  store.appendRecord(wrapRecord("observation", observation(day, H("1")), day));
  store.appendRecord(wrapRecord("observation", observation(20 * day, H("3")), 20 * day));
  store.appendRecord(wrapRecord("proposal", proposal(), day));
  store.appendRecord(wrapRecord("decision", decision(), day));
  store.appendRecord(auditEnvelope("applied", day));

  assert.deepEqual(store.retain(now), { observations: 1 });
  assert.equal(store.readRecords("observation").length, 1);
  assert.equal(store.readRecords("proposal").length, 1);
  assert.equal(store.readRecords("decision").length, 1);
  assert.equal(store.readRecords("audit-event").length, 1);
  store.close();
});

test("corrupt and unknown-version records are quarantined without disabling the store", () => {
  const { root, store } = fixture();
  const valid = wrapRecord("observation", observation(), 1_000);
  const corrupt = { ...valid, schemaVersion: "99.0.0" };

  assert.deepEqual(store.appendRecord(corrupt), { ok: false, reason: "unsupported-version" });
  assert.equal(readdirSync(path.join(root, "self-evolve", PROJECT, "quarantine")).filter((name) => name.endsWith(".quarantined")).length, 1);
  assert.equal(store.appendRecord(valid).ok, true);
  assert.equal(store.readRecords("observation").length, 1);
  store.close();
});

test("observation and proposal purge scopes retain audit and closed proposals", () => {
  const { store } = fixture();
  store.appendRecord(wrapRecord("observation", observation(), 1_000));
  store.appendRecord(wrapRecord("proposal", proposal("pending"), 1_000));
  store.appendRecord(wrapRecord("proposal", proposal("rejected", 1), 1_001));
  store.appendRecord(auditEnvelope("applied"));

  assert.equal(store.purge({ scope: "observations" }).counts.observations, 1);
  assert.equal(store.readRecords("observation").length, 0);
  assert.equal(store.purge({ scope: "proposals" }).counts.proposals, 1);
  assert.equal(store.readRecords("proposal").length, 1);
  assert.equal(store.readRecords("proposal")[0].payload.state, "rejected");
  assert.equal(store.readRecords("audit-event").length, 3);
  store.close();
});

test("project purge leaves only its purge audit while all purge removes the subtree", () => {
  const projectFixture = fixture();
  projectFixture.store.appendRecord(wrapRecord("observation", observation(), 1_000));
  projectFixture.store.appendRecord(wrapRecord("proposal", proposal(), 1_000));
  const projectResult = projectFixture.store.purge({ scope: "project" });
  assert.equal(projectResult.counts.observations, 1);
  assert.equal(projectResult.counts.proposals, 1);
  assert.equal(projectFixture.store.readRecords("audit-event").length, 1);
  assert.equal(projectFixture.store.readRecords("audit-event")[0].payload.kind, "purge");
  projectFixture.store.close();

  const allFixture = fixture();
  allFixture.store.appendRecord(wrapRecord("observation", observation(), 1_000));
  assert.equal(allFixture.store.purge({ scope: "all" }).counts.observations, 1);
  assert.equal(existsSync(path.join(allFixture.root, "self-evolve")), false);
  allFixture.store.close();
});

test("export produces a JSON archive that round-trips", () => {
  const { store } = fixture();
  store.appendRecord(wrapRecord("observation", observation(), 1_000));
  store.appendRecord(wrapRecord("proposal", proposal(), 1_000));

  const archive = store.exportAll();
  assert.deepEqual(JSON.parse(JSON.stringify(archive)), archive);
  assert.equal(archive.projectFingerprint, PROJECT);
  assert.equal(archive.records.length, 2);
  store.close();
});

test("restart surfaces applied audit events missing readback verification", () => {
  const { root, store } = fixture();
  const applied = auditEnvelope("applied", 1_000);
  store.appendRecord(applied);
  assert.deepEqual(store.getRecoveryPending(), [applied]);
  store.close();

  const reopened = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => 2_000 });
  assert.deepEqual(reopened.getRecoveryPending(), [applied]);
  reopened.appendRecord(auditEnvelope("readback-verified", 1_100));
  assert.deepEqual(reopened.getRecoveryPending(), []);
  reopened.close();
});

test("startup quarantines a truncated JSONL tail and preserves its valid prefix", () => {
  const { root, store } = fixture();
  const envelope = wrapRecord("observation", observation(), 1_000);
  store.appendRecord(envelope);
  store.close();

  const state = path.join(root, "self-evolve", PROJECT);
  appendFileSync(path.join(state, "observations.jsonl"), '{"schemaVersion":"0.2.0","kind":"observation"', "utf8");
  const reopened = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => 2_000 });
  assert.deepEqual(reopened.readRecords("observation"), [envelope]);
  assert.equal(readdirSync(path.join(state, "quarantine")).filter((name) => name.endsWith(".quarantined")).length, 1);
  assert.equal(readFileSync(path.join(state, "observations.jsonl"), "utf8").trim(), JSON.stringify(envelope));
  reopened.close();
});

test("fingerprints canonicalize remotes and migration rejects newer versions", () => {
  assert.equal(projectFingerprintFor("https://GitHub.com/example/repo.git/", "/one"), projectFingerprintFor("https://github.com/example/repo", "/two"));
  assert.equal(projectFingerprintFor("", "/tmp/project"), hashContent(path.resolve("/tmp/project")));
  assert.equal(migrate({ schemaVersion: "9.0.0" }), null);
  assert.equal(migrate({ schemaVersion: "0.1.0", global: {}, repo: {} }).schemaVersion, SCHEMA_VERSION);
});
