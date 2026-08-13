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
    ["/self-evolve help", "help"], ["?", "help"], ["status", "status"], ["on", "automatic-recommendations"], ["off", "automatic-recommendations"],
    ["scan", "removed"], ["pause", "removed"], ["resume", "removed"], ["review se-1", "review"], [approvalInput(), "approve"],
    ["reject se-1", "reject"], ["snooze se-1 7d", "snooze"], ["undo se-1", "undo"],
    ["exclude", "repo-override"], ["include", "repo-override"], ["repo inherit", "removed"],
    ["consent passive on", "removed"], ["consent observations off", "consent"], ["allowlist list", "allowlist"],
    ["allowlist add /skills --confirm UPDATE ALLOWLIST", "allowlist"], ["inspect observations 3", "inspect"],
    ["inspect eligibility", "inspect"], ["inbox", "inbox"], ["export all", "export"],
    ["export global-recommendations", "export"], ["purge global-recommendations", "purge"],
    [`purge global-recommendation ${HASH_A}`, "purge"],
    ["purge --all --confirm PURGE ALL SELF-EVOLVE 0.4.0", "purge"],
    ["budget", "budget"], ["health", "health"], ["kill-switch on", "kill-switch"],
  ];
  for (const [input, verb] of cases) assert.equal(command(input).verb, verb, input);
  assert.deepEqual(command(`purge global-recommendation ${HASH_A}`), {
    verb: "purge",
    scope: "global-recommendation",
    recommendationId: HASH_A,
  });
  assert.deepEqual(command("purge --all --confirm PURGE ALL SELF-EVOLVE 0.4.0"), {
    verb: "purge",
    scope: "all",
    confirmation: "PURGE ALL SELF-EVOLVE 0.4.0",
  });
  for (const input of [
    "purge --all",
    "purge all",
    "purge --all --confirm PURGE ALL SELF-EVOLVE 0.2.0",
    "purge --all --confirm PURGE ALL SELF-EVOLVE 0.4.0 extra",
  ]) assert.equal(parseSelfEvolveCommand(input).ok, false, input);
  assert.equal(parseSelfEvolveCommand("approve").ok, false);
  assert.equal(parseSelfEvolveCommand("allowlist add /skills").ok, false);
  assert.equal(parseSelfEvolveCommand("purge").ok, false);
  assert.equal(parseSelfEvolveCommand("wat").ok, false);
});

test("path-valued commands accept quoted and escaped spaces without consuming trailing flags", () => {
  assert.deepEqual(command("allowlist add '/skills/team tools' --confirm UPDATE ALLOWLIST"), {
    verb: "allowlist", action: "add", path: "/skills/team tools", confirmation: "UPDATE ALLOWLIST",
  });
  assert.equal(command("allowlist remove /skills/team\\ tools --confirm UPDATE ALLOWLIST").path, "/skills/team tools");
  assert.equal(command('allowlist add "/skills/\\"quoted\\" tools" --confirm UPDATE ALLOWLIST').path, '/skills/"quoted" tools');
  assert.equal(command("allowlist add /skills --confirm UPDATE ALLOWLIST").path, "/skills");

  for (const input of [
    "allowlist add '/skills/team tools' --confirm UPDATE ALLOWLIST --extra",
    "allowlist add /skills team --confirm UPDATE ALLOWLIST",
  ]) assert.equal(parseSelfEvolveCommand(input).ok, false, input);
});

test("command tokenizer rejects malformed quoting and escaping fail closed", () => {
  for (const input of [
    'allowlist add "/skills/team tools',
    "allowlist add '/skills/team tools --confirm UPDATE ALLOWLIST",
    "allowlist add /skills/team\\",
    'allowlist add "/skills/team tools\\',
  ]) {
    const result = parseSelfEvolveCommand(input);
    assert.equal(result.ok, false, input);
    assert.match(result.error, /^Malformed command:/u);
  }
});

test("status exposes binary preference, permissions, and creation-policy suggestions headlessly", (t) => {
  const { policy, store } = fixture(t);
  const current = store.getSettings().global;
  assert.equal(store.updateGlobalSettings(() => ({ ...current, allowedSkillRoots: ["/skills"], updatedAt: current.updatedAt + 1 })).ok, true);
  const status = policy.execute(command("status"), { projectFingerprint: FINGERPRINT }).responseText;
  assert.match(status, /Automatic recommendations: On; project Included; Emergency Stop Off/u);
  assert.match(status, /Permissions: observations on; excerpts on; cross-repo on/u);
  assert.match(status, /Creation-policy suggestions \(1\):\n- \/skills/u);
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
  assert.deepEqual(command(approvalInput("se-new", { targetHash: "must-not-exist", decisionVersion: 2 })), {
    verb: "approve", proposalId: "se-new", targetHash: "must-not-exist", proposedContentHash: HASH_B, decisionVersion: 2, nonce: NONCE,
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
    approvalInput("se-1", { targetHash: "must-not-exists" }),
    approvalInput("se-1", { proposedContentHash: "abc" }),
    approvalInput("se-1", { decisionVersion: 0 }),
    approvalInput("se-1", { decisionVersion: "1.5" }),
    approvalInput("se-1", { decisionVersion: "9007199254740992" }),
    approvalInput("se-1", { nonce: "not-a-server-nonce" }),
  ]) assert.equal(parseSelfEvolveCommand(input).ok, false, input);
});

test("bare command opens status and help documents the binary migration", () => {
  assert.equal(command("/self-evolve").verb, "default");
  for (const removed of ["manual", "auto", "yolo", "scan", "pause", "resume", "disable", "repo manual", "consent passive on"]) {
    assert.equal(command(removed).verb, "removed", removed);
  }
  const help = buildResponse(command("help"));
  assert.match(help, /\/self-evolve on \| off/u);
  assert.match(help, /dismiss/u);
  assert.match(help, new RegExp(MIGRATION_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("On and Off update the sole automation preference and On restores required permissions", (t) => {
  const { policy } = fixture(t);
  let result = policy.execute(command("off"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getAutomation().enabled, false);
  assert.match(result.responseText, /Future analysis is stopped/u);
  assert.match(result.responseText, /retained data was not purged/u);

  result = policy.execute(command("on"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getAutomation().enabled, true);
  assert.deepEqual(policy.getConsent(), {
    durableObservations: true,
    sanitizedExcerpts: true,
    crossRepoAggregation: true,
  });
  assert.match(result.responseText, /Required data permissions are On/u);
});

test("permission revocation turns automation Off and restoration leaves it Off", (t) => {
  const { policy } = fixture(t);
  const revoked = policy.execute(command("consent excerpts off"), { projectFingerprint: FINGERPRINT });
  assert.match(revoked.responseText, /disabled/u);
  assert.equal(policy.getAutomation().enabled, false);
  assert.equal(policy.getConsent().sanitizedExcerpts, false);

  const restored = policy.execute(command("consent excerpts on"), { projectFingerprint: FINGERPRINT });
  assert.match(restored.responseText, /Disclosure:/u);
  assert.equal(policy.getConsent().sanitizedExcerpts, true);
  assert.equal(policy.getAutomation().enabled, false);
});

test("project exclusion and Emergency Stop do not rewrite the automation preference", (t) => {
  const { policy } = fixture(t);
  const excluded = policy.execute(command("exclude"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getAutomation().repo.excluded, true);
  assert.equal(policy.getAutomation().enabled, true);
  assert.match(excluded.responseText, /Project Excluded/u);
  policy.execute(command("include"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getAutomation().repo.excluded, false);

  const stopped = policy.execute(command("kill-switch on"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getHealth().killSwitchActive, true);
  assert.equal(policy.getAutomation().enabled, true);
  assert.match(stopped.responseText, /preference is unchanged/u);
  policy.execute(command("kill-switch off"), { projectFingerprint: FINGERPRINT });
  assert.equal(policy.getHealth().killSwitchActive, false);
  assert.equal(policy.getAutomation().enabled, true);
});

test("removed controls return deterministic migration guidance without material reads", () => {
  const policy = createCommandPolicy({
    store: {
      getSettings() { throw new Error("material-read-attempted"); },
    },
    privacy: {
      exportScope() { throw new Error("material-effect-attempted"); },
      purgeScope() { throw new Error("material-effect-attempted"); },
    },
    now: () => 1_000,
  });
  for (const input of ["manual", "auto", "yolo", "scan", "pause", "resume", "disable", "repo auto", "consent passive on"]) {
    const result = policy.execute(command(input));
    assert.match(result.responseText, /was removed in Self-evolve v0\.4/u, input);
    assert.match(result.responseText, /Automatic recommendations On or Off/u, input);
  }
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

test("purge observations, proposals, and project report correct counts while purge-all remains integration-owned", (t) => {
  for (const scope of ["observations", "proposals", "project"]) {
    const nested = awaitFixture(t);
    seedObservation(nested.store, `obs-${scope}`);
    seedProposal(nested.store, `se-${scope}`);
    const result = nested.policy.execute(command(`purge ${scope}`), { projectFingerprint: FINGERPRINT });
    assert.match(result.responseText, new RegExp(`Purge ${scope} completed`));
    if (scope === "observations") assert.match(result.responseText, /"observations":1/);
    if (scope === "proposals") assert.match(result.responseText, /"proposals":1/);
    if (scope === "project") {
      assert.match(result.responseText, /"observations":1/);
      assert.match(result.responseText, /"proposals":1/);
    }
  }
  const terminal = awaitFixture(t);
  seedObservation(terminal.store, "obs-all");
  const result = terminal.policy.execute(command("purge --all --confirm PURGE ALL SELF-EVOLVE 0.4.0"), { projectFingerprint: FINGERPRINT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "purge-all-requires-terminal-integration");
  assert.equal(terminal.store.readRecords("observation").length, 1, "command policy cannot delete before integration accepts terminal");
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

test("headless commands return plain text and removed commands schedule no automatic work", (t) => {
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
  assert.equal(policy.getAutomation().enabled, true);
});

test("removed disable is side-effect free and the default opens preference plus inbox", (t) => {
  const { policy, store } = fixture(t);
  seedProposal(store, "se-default");
  const disabled = policy.execute(command("disable"), { projectFingerprint: FINGERPRINT });
  assert.match(disabled.responseText, /was removed in Self-evolve v0\.4/u);
  assert.equal(policy.getAutomation().enabled, true);
  const opened = policy.execute(command("/self-evolve"), { projectFingerprint: FINGERPRINT });
  assert.match(opened.responseText, /Automatic recommendations: On/u);
  assert.match(opened.responseText, /Inbox: 1 pending proposal/);
});

test("v0.4 retires scan and mode help while preserving unrelated headless commands", (t) => {
  const { policy } = fixture(t);
  const parsedScan = parseSelfEvolveCommand("scan");
  assert.deepEqual(parsedScan, { ok: true, command: { verb: "removed", removedCommand: "scan" } });
  const scan = policy.execute(command("scan"), { projectFingerprint: FINGERPRINT });
  assert.match(scan.responseText, /was removed in Self-evolve v0\.4/u);
  const help = buildResponse(command("help"));
  assert.match(help, /\/self-evolve on \| off/u);
  assert.doesNotMatch(help, /repo <manual\|auto\|inherit>/u);
  assert.equal(/unattended/iu.test(help), false);
});
