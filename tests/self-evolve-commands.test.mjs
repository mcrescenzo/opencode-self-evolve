import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_OBSERVATION_INSPECTION,
  MIGRATION_NOTE,
  buildResponse,
  createCommandPolicy,
  parseSelfEvolveCommand,
} from "../self-evolve-commands.js";
import { createPrivacyGuard } from "../self-evolve-privacy.js";
import {
  SCHEMA_VERSION,
  makeAuditEvent,
  makeObservation,
  makeProposal,
  wrapRecord,
} from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";

const FINGERPRINT = "a".repeat(64);
const HASH_A = "b".repeat(64);
const HASH_B = "c".repeat(64);
const NONCE = "d".repeat(48);

function approvalInput(id = "se-1", overrides = {}) {
  return `/self-evolve approve ${id} --target-hash ${overrides.targetHash ?? HASH_A} --proposed-content-hash ${overrides.proposedContentHash ?? HASH_B} --decision-version ${overrides.decisionVersion ?? 1} --nonce ${overrides.nonce ?? NONCE}`;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function fixture(t, { timestamp = 1_000 } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-commands-"));
  let clock = timestamp;
  const now = () => clock;
  const store = openStore(root, { projectName: "fixture", projectFingerprint: FINGERPRINT, now });
  const privacy = createPrivacyGuard({
    consent: { sanitizedExcerpts: true },
    projectFingerprint: FINGERPRINT,
    store,
    now,
  });
  const policy = createCommandPolicy({ store, privacy, schemaVersion: SCHEMA_VERSION, hostVersion: "1.18.3", now });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, privacy, policy, now, advance: (milliseconds) => { clock += milliseconds; } };
}

function command(input, options) {
  const result = parseSelfEvolveCommand(input, options);
  assert.equal(result.ok, true, result.error);
  return result.command;
}

function proposal(id, state = "pending", overrides = {}) {
  return makeProposal({
    id,
    projectFingerprint: FINGERPRINT,
    clusterId: hash(`cluster:${id}`),
    skillTarget: { canonicalRoot: "/skills", relativePath: `${id}/SKILL.md`, currentHash: HASH_A },
    proposedContentHash: HASH_B,
    rationaleText: `Improve command behavior for ${id}`,
    synthesizedAt: 900,
    synthesizerModelId: "test/model",
    criticScore: 0.9,
    criticPassed: true,
    validDeterministic: true,
    state,
    injectionFlagged: false,
    decisionVersion: 0,
    burnedNonceHashes: [],
    ...overrides,
  });
}

function seedProposal(store, id, state = "pending", overrides = {}, createdAt = 900) {
  const payload = proposal(id, state, overrides);
  assert.equal(store.appendRecord(wrapRecord("proposal", payload, createdAt)).ok, true);
  return payload;
}

function seedObservation(store, id, createdAt = 800) {
  const payload = makeObservation({
    id: hash(id),
    projectFingerprint: FINGERPRINT,
    receiptIds: [hash(`receipt:${id}`)],
    structuredFields: { receiptType: "repeated-command", scopeFingerprint: hash(`scope:${id}`), occurrences: 2 },
    incidentId: `incident-${id}`,
    createdAt,
    injectionFlagged: false,
    redacted: true,
  });
  assert.equal(store.appendRecord(wrapRecord("observation", payload, createdAt)).ok, true);
}

function seedApplyAudit(store, id, currentHash, appliedHash, timestamp = 950) {
  const details = { action: "apply", currentHash, appliedHash, state: "applied" };
  const payloadHash = hash(JSON.stringify(details));
  const event = makeAuditEvent({
    id: hash(`${id}:${currentHash}:${appliedHash}:${timestamp}`),
    kind: "apply",
    proposalId: id,
    actor: "self-evolve-applier",
    timestamp,
    payloadHash,
    details,
  });
  assert.equal(store.appendRecord(wrapRecord("audit-event", event, timestamp)).ok, true);
}

test("parser covers the complete command surface and rejects malformed input", () => {
  const cases = [
    ["/self-evolve help", "help"], ["?", "help"], ["scan", "scan"], ["status", "status"],
    ["pause", "pause"], ["resume", "resume"], ["review se-1", "review"], [approvalInput(), "approve"],
    ["reject se-1", "reject"], ["snooze se-1 7d", "snooze"], ["undo se-1", "undo"],
    ["exclude", "repo-override"], ["include", "repo-override"], ["repo inherit", "repo-mode"],
    ["consent passive on", "consent"], ["allowlist list", "allowlist"],
    ["allowlist add /skills --confirm UPDATE ALLOWLIST", "allowlist"], ["inspect observations 3", "inspect"],
    ["inspect eligibility", "inspect"], ["inbox", "inbox"], ["export all", "export"],
    ["purge --all", "purge"], ["budget", "budget"], ["health", "health"], ["kill-switch on", "kill-switch"],
  ];
  for (const [input, verb] of cases) assert.equal(command(input).verb, verb, input);
  assert.equal(parseSelfEvolveCommand("approve").ok, false);
  assert.equal(parseSelfEvolveCommand("allowlist add /skills").ok, false);
  assert.equal(parseSelfEvolveCommand("purge").ok, false);
  assert.equal(parseSelfEvolveCommand("wat").ok, false);
});

test("status exposes consent and approved skill folders headlessly", (t) => {
  const { policy } = fixture(t);
  policy.execute(command("consent passive on"), { projectFingerprint: FINGERPRINT });
  policy.execute(command("yolo confirm --allowlist /skills"), { projectFingerprint: FINGERPRINT });
  const status = policy.execute(command("status"), { projectFingerprint: FINGERPRINT }).responseText;
  assert.match(status, /Consent: passive on; observations off; excerpts off; cross-repo off/u);
  assert.match(status, /Approved skill folders \(1\):\n- \/skills/u);
});

test("observation inspection limit accepts only bounded positive safe integers", () => {
  assert.equal(command("inspect observations").limit, 20);
  assert.equal(command(`inspect observations ${MAX_OBSERVATION_INSPECTION}`).limit, MAX_OBSERVATION_INSPECTION);
  for (const value of [
    "0", "-1", "1.5", "1e2", "Infinity", "9007199254740992",
    String(MAX_OBSERVATION_INSPECTION + 1),
    "9".repeat(400),
  ]) {
    const result = parseSelfEvolveCommand(`inspect observations ${value}`);
    assert.equal(result.ok, false, value);
    assert.match(result.error, new RegExp(String(MAX_OBSERVATION_INSPECTION)));
  }
});

test("approval parser requires one exact tuple and rejects every malformed shape", () => {
  assert.deepEqual(command(approvalInput()), {
    verb: "approve", proposalId: "se-1", targetHash: HASH_A, proposedContentHash: HASH_B, decisionVersion: 1, nonce: NONCE,
  });
  for (const input of [
    "approve se-1",
    approvalInput().replace(` --target-hash ${HASH_A}`, ""),
    approvalInput().replace(` --proposed-content-hash ${HASH_B}`, ""),
    approvalInput().replace(" --decision-version 1", ""),
    approvalInput().replace(` --nonce ${NONCE}`, ""),
    `${approvalInput()} bare-id`,
    approvalInput().replace("--nonce", "--unknown"),
    approvalInput().replace(`--nonce ${NONCE}`, `--target-hash ${HASH_A}`),
    approvalInput("se-1", { targetHash: "A".repeat(64) }),
    approvalInput("se-1", { proposedContentHash: "abc" }),
    approvalInput("se-1", { decisionVersion: 0 }),
    approvalInput("se-1", { decisionVersion: "1.5" }),
    approvalInput("se-1", { decisionVersion: "9007199254740992" }),
    approvalInput("se-1", { nonce: "not-a-server-nonce" }),
  ]) assert.equal(parseSelfEvolveCommand(input).ok, false, input);
});

test("bare command migration and help preserve legacy mappings", () => {
  assert.equal(command("/self-evolve", { legacy: true }).verb, "scan");
  assert.equal(command("/self-evolve", { legacy: false }).verb, "default");
  const disabled = command("/self-evolve disable");
  assert.deepEqual(disabled, { verb: "pause", deprecatedAlias: "disable" });
  const help = buildResponse(command("help"));
  assert.match(help, /disable -> pause \(deprecated\)/);
  assert.match(help, /dismiss/);
  assert.match(help, new RegExp(MIGRATION_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("global modes transition both directions and mode changes require restart", (t) => {
  const { policy } = fixture(t);
  let result = policy.execute(command("auto"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getMode(), "auto");
  assert.match(result.responseText, /restarted for the new mode/i);
  policy.execute(command("manual"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getMode(), "manual");
  policy.execute(command("auto"), { projectFingerprint: FINGERPRINT });
  result = policy.execute(command("yolo confirm --allowlist /skills"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getMode(), "yolo");
  assert.match(result.responseText, /No proposal was accepted and no files were applied/);
  policy.execute(command("manual"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getMode(), "manual");
});

test("yolo confirmation and allowlist fail closed until the elevated command is valid", (t) => {
  const { policy } = fixture(t);
  const first = command("yolo");
  assert.equal(first.requiresConfirmation, true);
  assert.match(first.confirmationPrompt, /--allowlist/);
  assert.match(policy.execute(first, { projectFingerprint: FINGERPRINT }).responseText, /No mode change/);
  assert.equal(policy.getMode(), "manual");
  assert.equal(parseSelfEvolveCommand("yolo confirm").ok, false);
  const invalid = policy.setMode("yolo", { confirmed: true, allowlist: [] });
  assert.equal(invalid.ok, false);
  assert.equal(policy.getMode(), "manual");
});

test("kill switch downgrades effective mode without rewriting stored yolo preference", (t) => {
  const { policy } = fixture(t);
  policy.execute(command("yolo confirm --allowlist /skills"), { projectFingerprint: FINGERPRINT });
  const result = policy.execute(command("kill-switch on"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getMode(), "yolo");
  assert.equal(policy.getEffectiveMode({ projectFingerprint: FINGERPRINT }), "manual");
  assert.equal(policy.getHealth().killSwitchActive, true);
  assert.match(result.responseText, /Stored mode remains yolo/);
  policy.execute(command("kill-switch off"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getEffectiveMode({ projectFingerprint: FINGERPRINT }), "yolo");
});

test("repo mode precedence and exclusion coexist with the global preference", (t) => {
  const { policy, store } = fixture(t);
  policy.execute(command("auto"), { projectFingerprint: FINGERPRINT });
  policy.execute(command("repo manual"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getMode(), "auto");
  assert.equal(policy.getEffectiveMode({ projectFingerprint: FINGERPRINT }), "manual");
  policy.execute(command("repo yolo"), { projectFingerprint: FINGERPRINT });
  assert.equal(store.getSettings().repo.mode, "manual", "repo yolo must fail without changing the existing override");
  policy.execute(command("yolo confirm --allowlist /skills"), { projectFingerprint: FINGERPRINT });
  policy.execute(command("repo auto"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getEffectiveMode({ projectFingerprint: FINGERPRINT }), "auto");
  const excluded = policy.execute(command("exclude"), { projectFingerprint: FINGERPRINT });
  assert.equal(store.getSettings().repo.excluded, true);
  assert.equal(policy.getEffectiveMode({ projectFingerprint: FINGERPRINT }), "manual");
  assert.match(excluded.responseText, /autonomous work will be skipped/);
});

test("all consent keys toggle with first-enable disclosures and cross-repo requires excerpts", (t) => {
  const { policy } = fixture(t);
  for (const name of ["passive", "observations", "excerpts"]) {
    const first = policy.execute(command(`consent ${name} on`), { projectFingerprint: FINGERPRINT });
    assert.match(first.responseText, /Disclosure:/);
    const again = policy.execute(command(`consent ${name} on`), { projectFingerprint: FINGERPRINT });
    assert.doesNotMatch(again.responseText, /Disclosure:/);
    policy.execute(command(`consent ${name} off`), { projectFingerprint: FINGERPRINT });
  }
  const blocked = policy.execute(command("consent cross-repo on"), { projectFingerprint: FINGERPRINT });
  assert.match(blocked.responseText, /sanitized-excerpts-consent-required/);
  policy.execute(command("consent excerpts on"), { projectFingerprint: FINGERPRINT });
  const enabled = policy.execute(command("consent cross-repo on"), { projectFingerprint: FINGERPRINT });
  assert.match(enabled.responseText, /Disclosure:/);
  assert.equal(policy.getConsent().crossRepoAggregation, true);
  policy.execute(command("consent cross-repo off"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getConsent().crossRepoAggregation, false);
});

test("disabling sanitized excerpts while cross-repo aggregation is enabled is rejected", (t) => {
  const { policy } = fixture(t);
  policy.execute(command("consent excerpts on"), { projectFingerprint: FINGERPRINT });
  const enabled = policy.execute(command("consent cross-repo on"), { projectFingerprint: FINGERPRINT });
  assert.match(enabled.responseText, /Disclosure:/);
  assert.equal(policy.getConsent().crossRepoAggregation, true);
  const blocked = policy.execute(command("consent excerpts off"), { projectFingerprint: FINGERPRINT });
  assert.match(blocked.responseText, /cross-repository-aggregation-requires-excerpts/u);
  // The privacy invariant survives: excerpts remain on and aggregation stays consistent.
  assert.equal(policy.getConsent().sanitizedExcerpts, true);
  assert.equal(policy.getConsent().crossRepoAggregation, true);
});

test("newer settings fail closed to manual and refuse writes with a health message", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-commands-corrupt-"));
  const stateDir = path.join(root, "self-evolve", FINGERPRINT);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "settings.json"), `${JSON.stringify({ schemaVersion: "9.9.9" })}\n`);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 1_000 });
  const privacy = createPrivacyGuard({ consent: {}, projectFingerprint: FINGERPRINT, store, now: () => 1_000 });
  const policy = createCommandPolicy({ store, privacy, schemaVersion: SCHEMA_VERSION, hostVersion: "1.18.3", now: () => 1_000 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(policy.getMode(), "manual");
  assert.equal(policy.getEffectiveMode({ projectFingerprint: FINGERPRINT }), "manual");
  assert.match(policy.execute(command("auto"), { projectFingerprint: FINGERPRINT }).responseText, /Manual\/no-write mode/);
  assert.match(policy.execute(command("health"), { projectFingerprint: FINGERPRINT }).responseText, /Corrupt or unsupported settings/);
});

test("inbox lists pending proposals and review shows one proposal headlessly", (t) => {
  const { policy, store } = fixture(t);
  for (const id of ["se-1", "se-2", "se-3"]) seedProposal(store, id);
  seedProposal(store, "se-draft", "critic-pending", { criticPassed: false, criticScore: 0 });
  const inbox = policy.execute(command("inbox"), { projectFingerprint: FINGERPRINT });
  assert.match(inbox.responseText, /Pending proposals \(3\)/);
  for (const id of ["se-1", "se-2", "se-3"]) assert.match(inbox.responseText, new RegExp(id));
  const review = policy.execute(command("review se-2"), { projectFingerprint: FINGERPRINT });
  assert.match(review.responseText, /se-2/);
  assert.match(review.responseText, /Approval tuple unavailable/);
  assert.doesNotMatch(review.responseText, /proposedContent/);
  assert.match(policy.execute(command("review se-draft"), { projectFingerprint: FINGERPRINT }).responseText, /not reviewable, approvable, or applicable/u);
  assert.doesNotMatch(inbox.responseText, /se-draft/u);
});

test("command policy cannot turn a direct or internal approval shortcut into authority", (t) => {
  const { policy, store } = fixture(t);
  seedProposal(store, "se-approve");
  const result = policy.execute(command(approvalInput("se-approve")), { projectFingerprint: FINGERPRINT });
  assert.match(result.responseText, /durable server integration/);
  assert.equal(store.getRecord("proposal", "se-approve").payload.state, "pending");
  assert.equal(store.readRecords("decision").length, 0);
});

test("reject and legacy dismiss transition pending proposals to rejected", (t) => {
  const { policy, store } = fixture(t);
  seedProposal(store, "se-reject");
  seedProposal(store, "se-dismiss");
  policy.execute(command("reject se-reject"), { projectFingerprint: FINGERPRINT });
  policy.execute(command("dismiss se-dismiss"), { projectFingerprint: FINGERPRINT });
  assert.equal(store.getRecord("proposal", "se-reject").payload.state, "rejected");
  assert.equal(store.getRecord("proposal", "se-dismiss").payload.state, "rejected");
});

test("snooze keeps proposal pending and removes it from the default inbox window", (t) => {
  const { policy, store, advance } = fixture(t);
  seedProposal(store, "se-snooze");
  const result = policy.execute(command("snooze se-snooze 7d"), { projectFingerprint: FINGERPRINT });
  assert.equal(store.getRecord("proposal", "se-snooze").payload.state, "pending");
  assert.equal(store.readRecords("decision").at(-1).payload.newState, "pending");
  assert.equal(policy.getInbox().length, 0);
  assert.match(result.responseText, /remains pending and is snoozed until/);
  advance(7 * 86_400_000 + 1);
  assert.equal(policy.getInbox().length, 1);
});

test("observation export is scrubbed and scoped exports contain only requested records", (t) => {
  const { policy, store } = fixture(t);
  seedObservation(store, "obs-1");
  seedProposal(store, "se-export");
  const archive = JSON.parse(policy.execute(command("export observations"), { projectFingerprint: FINGERPRINT }).responseText);
  assert.equal(archive.exportScope, "observations");
  assert.equal(archive.records.length, 1);
  assert.equal(archive.records[0].kind, "observation");
  assert.equal(archive.records[0].payload.redacted, true);
  assert.doesNotMatch(JSON.stringify(archive), /rawMessage|transcript|messageBody/);
});

test("purge observations, proposals, project, and all report correct counts", (t) => {
  for (const scope of ["observations", "proposals", "project", "all"]) {
    const nested = awaitFixture(t);
    seedObservation(nested.store, `obs-${scope}`);
    seedProposal(nested.store, `se-${scope}`);
    const result = nested.policy.execute(command(`purge ${scope}`), { projectFingerprint: FINGERPRINT });
    assert.match(result.responseText, new RegExp(`Purge ${scope} completed`));
    if (scope === "observations") assert.match(result.responseText, /"observations":1/);
    if (scope === "proposals") assert.match(result.responseText, /"proposals":1/);
    if (scope === "project" || scope === "all") {
      assert.match(result.responseText, /"observations":1/);
      assert.match(result.responseText, /"proposals":1/);
    }
  }
});

function awaitFixture(t) {
  return fixture(t);
}

test("undo eligibility requires an applied proposal and an unchanged applied hash", (t) => {
  const matching = fixture(t);
  seedProposal(matching.store, "se-undo-ok", "applied");
  seedApplyAudit(matching.store, "se-undo-ok", HASH_B, HASH_B);
  const eligible = matching.policy.execute(command("undo se-undo-ok"), { projectFingerprint: FINGERPRINT });
  assert.match(eligible.responseText, /is eligible/);
  assert.match(eligible.responseText, /Rollback has not yet been applied/);

  const drifted = fixture(t);
  seedProposal(drifted.store, "se-undo-drift", "applied");
  seedApplyAudit(drifted.store, "se-undo-drift", HASH_A, HASH_B);
  const refused = drifted.policy.execute(command("undo se-undo-drift"), { projectFingerprint: FINGERPRINT });
  assert.match(refused.responseText, /hash-drift/);
  assert.match(refused.responseText, /No files were changed/);
});

test("headless commands return plain text and manual commands schedule no passive work", (t) => {
  const { policy, store } = fixture(t);
  seedProposal(store, "se-headless");
  for (const input of ["status", "health", "inbox", "review se-headless", "budget", "scan", "help"]) {
    const result = policy.execute(command(input), { projectFingerprint: FINGERPRINT });
    assert.equal(typeof result.responseText, "string");
    assert.equal("parts" in result, false);
    assert.equal("passiveCall" in result, false);
    assert.equal("scheduledAutonomousWork" in result, false);
    assert.doesNotMatch(result.responseText, /promptAsync|appendPrompt|passive-call-token/);
  }
  assert.equal(policy.getMode(), "manual");
});

test("disable response is deprecated pause and the new default opens status plus inbox", (t) => {
  const { policy, store } = fixture(t);
  seedProposal(store, "se-default");
  const disabled = policy.execute(command("disable"), { projectFingerprint: FINGERPRINT });
  assert.match(disabled.responseText, /Deprecated/);
  assert.equal(store.getSettings().global.paused, true);
  const opened = policy.execute(command("/self-evolve"), { projectFingerprint: FINGERPRINT });
  assert.match(opened.responseText, /Self-evolve status/);
  assert.match(opened.responseText, /Inbox: 1 pending proposal/);
});
