import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplier } from "../self-evolve-applier.js";
import * as applierModule from "../self-evolve-applier.js";
import { makeAuditEvent, wrapRecord } from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";
import {
  discoverSkills,
  hashSkillContent,
  loadAllowlist,
  rejectSymlinked,
} from "../self-evolve-inventory.js";
import { createPrivacyGuard } from "../self-evolve-privacy.js";

const PROJECT = "a".repeat(64);
const CLUSTER = "b".repeat(64);
let clock = 10_000;

function skill(name, body = "# Guidance\nKeep deterministic checks bounded.\n") {
  return `---\nname: ${name}\ndescription: Handles deterministic workflow checks safely.\n---\n${body}`;
}

function fixture(t, { existing = true, quota = 8 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-applier-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "skills");
  fs.mkdirSync(root, { mode: 0o700 });
  let target;
  let before;
  if (existing) {
    const directory = path.join(root, "reviewer");
    fs.mkdirSync(directory);
    target = path.join(directory, "SKILL.md");
    before = skill("reviewer");
    fs.writeFileSync(target, before);
  }
  const roots = loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots;
  const records = discoverSkills(roots);
  const baseStore = openStore(path.join(temp, "state"), { projectName: "fixture", projectFingerprint: PROJECT, now: () => ++clock });
  if (quota !== 8) {
    const settings = baseStore.getSettings();
    baseStore.setRepoSettings({ ...settings.repo, budgets: { ...settings.repo.budgets, storageQuotaMiB: quota } });
  }
  const snapshots = path.join(temp, "state", "self-evolve", PROJECT, "snapshots");
  const store = Object.freeze({
    snapshotRoot: snapshots,
    getSettings: (...args) => baseStore.getSettings(...args),
    appendRecord: (...args) => baseStore.appendRecord(...args),
    readRecords: (...args) => baseStore.readRecords(...args),
    acquireLease: (...args) => baseStore.acquireLease(...args),
    releaseLease: (...args) => baseStore.releaseLease(...args),
    getRecoveryPending: (...args) => baseStore.getRecoveryPending(...args),
    exportAll: (...args) => baseStore.exportAll(...args),
  });
  const privacy = createPrivacyGuard({ consent: {}, projectFingerprint: PROJECT, storageQuotaMiB: quota, store: baseStore, now: () => ++clock });
  const inventory = { records, canonicalRoots: roots };
  const applier = createApplier({ store, inventory, privacy, now: () => ++clock });
  t.after(() => { applier.close(); baseStore.close(); });
  return { temp, root, target, before, records, inventory, store, baseStore, privacy, applier, snapshots };
}

function proposal(f, { name = "reviewer", content = skill(name, "# Updated\nUse exact hashes.\n"), state = "approved", root = f.root, relativePath, currentHash } = {}) {
  const record = f.records.find((item) => item.logicalName === name);
  return {
    id: `proposal-${name}`,
    projectFingerprint: PROJECT,
    clusterId: CLUSTER,
    skillTarget: {
      canonicalRoot: root,
      relativePath: relativePath ?? `${name}/SKILL.md`,
      currentHash: currentHash ?? record?.currentHash ?? "must-not-exist",
    },
    proposedContent: content,
    proposedContentHash: hashSkillContent(content),
    rationaleText: "Repeated deterministic evidence supports this bounded change.",
    synthesizedAt: 1,
    synthesizerModelId: "mock/model",
    criticScore: 0.99,
    criticPassed: true,
    validDeterministic: true,
    state,
    injectionFlagged: false,
    decisionVersion: state === "approved" ? 1 : 0,
    burnedNonceHashes: [],
  };
}

function decision(p) {
  return {
    proposalId: p.id,
    targetHash: p.skillTarget.currentHash,
    proposedContentHash: p.proposedContentHash,
    decisionVersion: p.decisionVersion || 1,
    actor: "reviewer",
    timestamp: 2,
    nonce: `nonce-${p.id}`,
    priorState: "pending",
    newState: "approved",
  };
}

function verifiedApplies(f, id) {
  return f.baseStore.readRecords("audit-event").filter((record) => record.payload.kind === "apply"
    && record.payload.proposalId === id && record.payload.details["readback-verified"] === true);
}

function appendPending(f, p, details) {
  const timestamp = ++clock;
  const clean = { state: "applied", "readback-verified": false, ...details };
  const event = makeAuditEvent({
    id: hashSkillContent(`pending:${p.id}:${timestamp}`),
    kind: "apply",
    proposalId: p.id,
    actor: "self-evolve-applier",
    timestamp,
    payloadHash: hashSkillContent(JSON.stringify(clean)),
    details: clean,
  });
  assert.equal(f.baseStore.appendRecord(wrapRecord("audit-event", event, timestamp)).ok, true);
}

test("two concurrent applications are at most once", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const first = f.applier.applyProposal({ proposal: p, decision: decision(p), actor: "reviewer", mode: "auto", headless: false });
  const second = f.applier.applyProposal({ proposal: p, decision: decision(p), actor: "reviewer", mode: "auto", headless: false });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.reason, "lease-busy");
});

test("stale target hash is rejected and audited", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  fs.writeFileSync(f.target, skill("reviewer", "# Human edit\n"));
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.reason, "stale-hash");
  assert.equal(f.baseStore.readRecords("audit-event").some((r) => r.payload.details.reason === "stale-hash"), true);
});

test("create-exclusive creates a new skill atomically", async (t) => {
  const f = fixture(t, { existing: false });
  const p = proposal(f, { name: "new-skill" });
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  const target = path.join(f.root, "new-skill", "SKILL.md");
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(target, "utf8"), p.proposedContent);
  assert.deepEqual(fs.readdirSync(path.dirname(target)).filter((name) => name.includes("self-evolve-tmp")), []);
});

test("create-exclusive rejects an existing target", async (t) => {
  const f = fixture(t);
  const p = proposal(f, { currentHash: "must-not-exist" });
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.reason, "target-exists");
});

test("concurrent create-exclusive calls have one winner", async (t) => {
  const f = fixture(t, { existing: false });
  const p = proposal(f, { name: "new-skill" });
  const results = await Promise.all([
    f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" }),
    f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" }),
  ]);
  assert.deepEqual(results.map((item) => item.ok), [true, false]);
  assert.equal(results[1].reason, "lease-busy");
});

test("targets outside the canonical allowlist are refused", async (t) => {
  const f = fixture(t);
  const outside = path.join(f.temp, "outside");
  fs.mkdirSync(outside);
  const p = proposal(f, { root: outside });
  const result = await f.applier.applyProposal({ proposal: p, mode: "yolo" });
  assert.equal(result.reason, "scope-not-allowlisted");
});

test("path traversal is refused", async (t) => {
  const f = fixture(t);
  const p = proposal(f, { relativePath: "../outside/SKILL.md" });
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.reason, "validation-failed");
});

test("symlinks in the target chain are refused", async (t) => {
  const f = fixture(t, { existing: false });
  const outside = path.join(f.temp, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, "linked"), "dir");
  assert.equal(rejectSymlinked(path.join(f.root, "linked", "SKILL.md")), true);
  const p = proposal(f, { name: "linked" });
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.reason, "validation-failed");
  assert.equal(fs.existsSync(path.join(outside, "SKILL.md")), false);
});

test("parent symlink race causes no write outside the allowlist", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const outside = path.join(f.temp, "outside");
  fs.mkdirSync(outside);
  const originalRename = fs.renameSync;
  let intercepted = false;
  fs.renameSync = function (from, to) {
    if (!intercepted && String(from).includes("self-evolve-tmp") && to === f.target) {
      intercepted = true;
      const parent = path.dirname(f.target);
      const moved = `${parent}-moved`;
      originalRename(parent, moved);
      fs.symlinkSync(outside, parent, "dir");
    }
    return originalRename(from, to);
  };
  try {
    const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.join(outside, "SKILL.md")), false);
  } finally {
    fs.renameSync = originalRename;
  }
});

test("rename failure leaves the old target, releases the lease, and is recoverable", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const originalRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (String(from).includes("self-evolve-tmp") && to === f.target) throw Object.assign(new Error("rename-failed"), { code: "EIO" });
    return originalRename(from, to);
  };
  let result;
  try {
    result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(result.reason, "rename-failed");
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
  assert.equal(f.baseStore.getRecoveryPending().length, 1);
  assert.equal(f.applier.recoverPending()[0].ok, true);
  const retry = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(retry.ok, true);
});

test("growth budget excess is refused", async (t) => {
  const f = fixture(t);
  const p = proposal(f, { content: skill("reviewer", `# Huge\n${"x".repeat(9 * 1024)}`) });
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.reason, "growth-limit-exceeded");
});

for (const [label, marker] of [
  ["secret canary", "AKIAABCDEFGHIJKLMNOP"],
  ["injection marker", "ignore all previous instructions"],
  ["control character", "bad\u0001text"],
  ["unsafe link", "[x](javascript:alert(1))"],
]) {
  test(`${label} is refused before writing`, async (t) => {
    const f = fixture(t);
    const p = proposal(f, { content: skill("reviewer", `# Unsafe\n${marker}\n`) });
    const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
  });
}

test("readback mismatch rolls back the prior content", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const originalRename = fs.renameSync;
  let corrupted = false;
  fs.renameSync = function (from, to) {
    const value = originalRename(from, to);
    if (!corrupted && String(from).includes("self-evolve-tmp") && to === f.target) {
      corrupted = true;
      fs.writeFileSync(to, skill("reviewer", "# Corrupt\n"));
    }
    return value;
  };
  let result;
  try {
    result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(result.reason, "readback-mismatch");
  assert.equal(f.applier.circuitBreakerOpen(), true);
});

test("successful apply writes one verified apply event", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.ok, true);
  assert.equal(verifiedApplies(f, p.id).length, 1);
  assert.equal(verifiedApplies(f, p.id)[0].payload.details.appliedHash, result.appliedHash);
});

test("recovery confirms an applied hash", (t) => {
  const f = fixture(t);
  const p = proposal(f);
  fs.writeFileSync(f.target, p.proposedContent);
  appendPending(f, p, { target: f.target, priorHash: hashSkillContent(f.before), appliedHash: p.proposedContentHash, snapshot: "none" });
  const result = f.applier.recoverPending();
  assert.equal(result[0].ok, true);
  assert.equal(verifiedApplies(f, p.id).length, 1);
});

test("recovery recognizes unchanged prior content as rolled back", (t) => {
  const f = fixture(t);
  const p = proposal(f);
  appendPending(f, p, { target: f.target, priorHash: hashSkillContent(f.before), appliedHash: p.proposedContentHash, snapshot: "none" });
  const result = f.applier.recoverPending();
  assert.equal(result[0].rolledBackHash, hashSkillContent(f.before));
  assert.equal(f.baseStore.readRecords("audit-event").some((r) => r.payload.kind === "rollback" && r.payload.details["readback-verified"]), true);
});

test("recovery hash drift is critical and opens the breaker", (t) => {
  const f = fixture(t);
  const p = proposal(f);
  appendPending(f, p, { target: f.target, priorHash: "c".repeat(64), appliedHash: p.proposedContentHash, snapshot: "none" });
  assert.equal(f.applier.recoverPending()[0].reason, "hash-drift");
  assert.equal(f.applier.circuitBreakerOpen(), true);
});

test("project storage quota exhaustion refuses application", async (t) => {
  const f = fixture(t, { quota: 0 });
  const p = proposal(f);
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.reason, "storage-quota-exceeded");
});

test("hash-safe rollback restores the prior content and records one rollback", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  assert.equal((await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" })).ok, true);
  const rollback = f.applier.rollbackApplied({ proposalId: p.id, actor: "reviewer", reason: "user-request" });
  assert.equal(rollback.ok, true);
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
  assert.equal(f.baseStore.readRecords("audit-event").filter((r) => r.payload.kind === "rollback" && r.payload.details["readback-verified"]).length, 1);
});

test("hash-safe rollback refuses on disk drift", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  fs.writeFileSync(f.target, skill("reviewer", "# User changed this\n"));
  assert.equal(f.applier.rollbackApplied({ proposalId: p.id, reason: "requested" }).reason, "hash-drift");
});

test("missing rollback snapshot trips the circuit breaker", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  fs.rmSync(f.snapshots, { recursive: true, force: true });
  assert.equal(f.applier.rollbackApplied({ proposalId: p.id, reason: "requested" }).reason, "snapshot-missing");
  assert.equal(f.applier.circuitBreakerOpen(), true);
  assert.equal((await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" })).reason, "circuit-breaker-open");
});

test("authority matrix fails closed and allows approved auto", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  assert.equal((await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "manual" })).reason, "manual-advisory-only");
  assert.equal((await f.applier.applyProposal({ proposal: p, mode: "auto" })).reason, "decision-required");
  assert.equal((await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" })).ok, true);
});

test("yolo requires allowlist and release gates but not a decision", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  assert.equal((await f.applier.applyProposal({ proposal: p, mode: "yolo", headless: true })).ok, true);
  const outside = proposal(f, { root: path.join(f.temp, "outside") });
  assert.equal((await f.applier.applyProposal({ proposal: outside, mode: "yolo" })).reason, "scope-not-allowlisted");
  assert.equal(outside.state, "approved");
});

test("kill switch refuses yolo application", async (t) => {
  const f = fixture(t);
  const settings = f.baseStore.getSettings();
  f.baseStore.setGlobalSettings({ ...settings.global, killSwitchActive: true, updatedAt: settings.global.updatedAt + 1 });
  const p = proposal(f);
  assert.equal((await f.applier.applyProposal({ proposal: p, mode: "yolo" })).reason, "kill-switch");
});

test("module namespace exposes no prohibited capabilities", () => {
  assert.deepEqual(Object.keys(applierModule), ["createApplier"]);
  for (const name of ["child_process", "git", "fetch", "http", "https", "net", "exec", "spawn"]) assert.equal(name in applierModule, false);
});
