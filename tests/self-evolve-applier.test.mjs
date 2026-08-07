import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createApplier } from "../self-evolve-applier.js";
import * as applierModule from "../self-evolve-applier.js";
import { makeAuditEvent, makeProposal, wrapRecord } from "../self-evolve-schemas.js";
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
const NEW_SKILL_CRASH_CHILD = path.join(import.meta.dirname, "fixtures", "new-skill-crash.mjs");
let clock = 10_000;

function skill(name, body = "# Guidance\nKeep deterministic checks bounded.\n") {
  return `---\nname: ${name}\ndescription: Handles deterministic workflow checks safely.\n---\n${body}`;
}

function fixture(t, { existing = true, quota = 8, releaseLease, appendRecord, faultInjection } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-applier-"));
  let applier;
  let baseStore;
  t.after(() => {
    try { applier?.close(); } catch {}
    try { baseStore?.close(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  });
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
  baseStore = openStore(path.join(temp, "state"), { projectName: "fixture", projectFingerprint: PROJECT, now: () => ++clock });
  if (quota !== 8) {
    const settings = baseStore.getSettings();
    baseStore.setRepoSettings({ ...settings.repo, budgets: { ...settings.repo.budgets, storageQuotaMiB: quota } });
  }
  const snapshots = path.join(temp, "state", "self-evolve", PROJECT, "snapshots");
  const store = Object.freeze({
    snapshotRoot: snapshots,
    getSettings: (...args) => baseStore.getSettings(...args),
    appendRecord: (...args) => appendRecord ? appendRecord(baseStore, ...args) : baseStore.appendRecord(...args),
    readRecords: (...args) => baseStore.readRecords(...args),
    acquireLease: (...args) => baseStore.acquireLease(...args),
    releaseLease: (...args) => releaseLease ? releaseLease(baseStore, ...args) : baseStore.releaseLease(...args),
    getLeaseStatus: (...args) => baseStore.getLeaseStatus(...args),
    getRecoveryPending: (...args) => baseStore.getRecoveryPending(...args),
    exportAll: (...args) => baseStore.exportAll(...args),
  });
  const privacy = createPrivacyGuard({ consent: {}, projectFingerprint: PROJECT, storageQuotaMiB: quota, store: baseStore, now: () => ++clock });
  const inventory = { records, canonicalRoots: roots, discoverSkills };
  applier = createApplier({ store, inventory, privacy, now: () => ++clock, faultInjection });
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
  const clean = { state: "applied", canonicalRoot: p.skillTarget.canonicalRoot, "readback-verified": false, ...details };
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

test("a failed content write cleans up the exclusive temp file instead of leaking it", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const realOpen = fs.openSync;
  const realWrite = fs.writeFileSync;
  const tempFds = new Set();
  fs.openSync = (target, ...args) => {
    const fd = realOpen(target, ...args);
    if (typeof target === "string" && target.includes(".self-evolve-tmp-")) tempFds.add(fd);
    return fd;
  };
  fs.writeFileSync = (fdOrPath, ...args) => {
    if (tempFds.has(fdOrPath)) throw new Error("injected-write-failure");
    return realWrite(fdOrPath, ...args);
  };
  let result;
  try {
    result = await f.applier.applyProposal({ proposal: p, decision: decision(p), actor: "reviewer", mode: "auto", headless: false });
  } finally {
    fs.openSync = realOpen;
    fs.writeFileSync = realWrite;
  }
  assert.equal(result.ok, false);
  assert.match(result.reason, /injected-write-failure/u);
  const leaked = fs.readdirSync(path.dirname(f.target)).filter((name) => name.includes(".self-evolve-tmp-"));
  assert.deepEqual(leaked, [], "no exclusive temp file leaks after a write failure");
});

test("a failed temp readback removes the exclusive temp file", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const realRead = fs.readFileSync;
  fs.readFileSync = (target, ...args) => {
    if (typeof target === "string" && target.includes(".self-evolve-tmp-")) throw new Error("injected-readback-failure");
    return realRead(target, ...args);
  };
  let result;
  try {
    result = await f.applier.applyProposal({ proposal: p, decision: decision(p), actor: "reviewer", mode: "auto", headless: false });
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(result.ok, false);
  assert.match(result.reason, /injected-readback-failure/u);
  const leaked = fs.readdirSync(path.dirname(f.target)).filter((name) => name.includes(".self-evolve-tmp-"));
  assert.deepEqual(leaked, []);
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
  const candidate = proposal(f, { name: "new-skill", state: "pending" });
  const { proposedContent, ...durable } = candidate;
  const p = { ...makeProposal(durable), proposedContent, state: "approved", decisionVersion: 1 };
  const approved = decision(p);
  const result = await f.applier.applyProposal({ proposal: p, decision: approved, mode: "auto" });
  const target = path.join(f.root, "new-skill", "SKILL.md");
  assert.equal(approved.targetHash, "must-not-exist");
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(target, "utf8"), p.proposedContent);
  assert.equal(verifiedApplies(f, p.id)[0].payload.details.priorHash, "must-not-exist");
  assert.deepEqual(fs.readdirSync(path.dirname(target)).filter((name) => name.includes("self-evolve-tmp")), []);
});

test("new-skill approval uses full decision schema and transition validation", async (t) => {
  for (const [label, mutate] of [
    ["unexpected field", (approved) => ({ ...approved, extra: true })],
    ["invalid prior state", (approved) => ({ ...approved, priorState: "approved" })],
    ["stale decision version", (approved) => ({ ...approved, decisionVersion: approved.decisionVersion + 1 })],
  ]) {
    await t.test(label, async (t) => {
      const f = fixture(t, { existing: false });
      const p = proposal(f, { name: `new-${label.replaceAll(" ", "-")}` });
      const result = await f.applier.applyProposal({ proposal: p, decision: mutate(decision(p)), mode: "auto" });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "decision-required");
      assert.equal(fs.existsSync(path.join(f.root, p.skillTarget.relativePath)), false);
    });
  }
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

test("different proposals concurrently creating one target publish exactly one complete file", async (t) => {
  const f = fixture(t, { existing: false });
  const first = proposal(f, { name: "new-skill" });
  const second = { ...first, id: "proposal-new-skill-second" };
  const results = await Promise.all([
    f.applier.applyProposal({ proposal: first, decision: decision(first), mode: "auto" }),
    f.applier.applyProposal({ proposal: second, decision: decision(second), mode: "auto" }),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.find((item) => !item.ok).reason, "target-exists");
  assert.equal(fs.readFileSync(path.join(f.root, "new-skill", "SKILL.md"), "utf8"), first.proposedContent);
});

test("a target collision after final validation fails closed at create-exclusive publication", async (t) => {
  const f = fixture(t, { existing: false });
  const p = proposal(f, { name: "new-skill" });
  const target = path.join(f.root, "new-skill", "SKILL.md");
  const competing = skill("new-skill", "# Competing writer\nKeep this content.\n");
  const originalLink = fs.linkSync;
  let collided = false;
  fs.linkSync = function (from, to) {
    if (!collided && to === target) {
      collided = true;
      fs.writeFileSync(target, competing, { flag: "wx" });
    }
    return originalLink(from, to);
  };
  let result;
  try {
    result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(result.ok, false);
  assert.equal(result.reason, "target-exists");
  assert.equal(fs.readFileSync(target, "utf8"), competing);
  assert.equal(verifiedApplies(f, p.id).length, 0);
});

test("new-skill temp unlink failure rolls back the published target", async (t) => {
  const f = fixture(t, { existing: false });
  const p = proposal(f, { name: "new-skill" });
  const target = path.join(f.root, "new-skill", "SKILL.md");
  const originalUnlink = fs.unlinkSync;
  let failed = false;
  fs.unlinkSync = function (candidate) {
    if (!failed && String(candidate).includes(".self-evolve-tmp-")) {
      failed = true;
      throw Object.assign(new Error("temp-unlink-failed"), { code: "EIO" });
    }
    return originalUnlink(candidate);
  };
  let result;
  try {
    result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(result.ok, false);
  assert.equal(result.reason, "temp-unlink-failed");
  assert.equal(result.leaseStatus, "released");
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
  const rollback = f.baseStore.readRecords("audit-event").findLast((record) => record.payload.kind === "rollback" && record.payload.proposalId === p.id);
  assert.equal(rollback.payload.details.state, "rolled-back");
  assert.equal(rollback.payload.details.rolledBackHash, "must-not-exist");
  assert.equal(rollback.payload.details["readback-verified"], true);
  assert.equal(result.auditId, rollback.payload.id);
  assert.deepEqual(f.applier.recoverPending(), []);
});

test("new-skill recovery rolls back when its verified hardlink temp cannot be unlinked", (t) => {
  const f = fixture(t, { existing: false });
  const p = proposal(f, { name: "new-skill" });
  const target = path.join(f.root, "new-skill", "SKILL.md");
  fs.mkdirSync(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.SKILL.md.self-evolve-tmp-recovery`);
  fs.writeFileSync(temporary, p.proposedContent);
  fs.linkSync(temporary, target);
  appendPending(f, p, {
    target,
    priorHash: "must-not-exist",
    appliedHash: p.proposedContentHash,
    actor: "reviewer",
    mode: "auto",
    leaseNonce: "crashed-lease",
    snapshot: "none",
    temporary,
    temporaryHash: p.proposedContentHash,
  });
  const originalUnlink = fs.unlinkSync;
  let failed = false;
  fs.unlinkSync = function (candidate) {
    if (!failed && candidate === temporary) {
      failed = true;
      throw Object.assign(new Error("recovery-temp-unlink-failed"), { code: "EIO" });
    }
    return originalUnlink(candidate);
  };
  let outcome;
  try {
    outcome = f.applier.recoverPending().find((item) => item.proposalId === p.id);
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "recovery-temp-unlink-failed");
  assert.equal(outcome.rolledBackHash, "must-not-exist");
  assert.equal(outcome.leaseStatus, "released");
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
  const rollback = f.baseStore.readRecords("audit-event").findLast((record) => record.payload.kind === "rollback" && record.payload.proposalId === p.id);
  assert.equal(rollback.payload.details.state, "rolled-back");
  assert.equal(rollback.payload.details["readback-verified"], true);
  assert.equal(outcome.auditId, rollback.payload.id);
  assert.deepEqual(f.applier.recoverPending(), []);
});

for (const point of ["apply-after-pending-audit", "apply-after-new-target-link", "apply-after-publication", "apply-after-readback-audit"]) {
  test(`new-skill process kill at ${point} leaves absent or complete content and recovers once`, async (t) => {
    const f = fixture(t, { existing: false });
    const content = skill("crash-skill", "# Complete\nNever publish partial content.\n");
    const pending = proposal(f, { name: "crash-skill", content, state: "pending" });
    const { proposedContent: _proposedContent, ...durablePending } = pending;
    f.baseStore.appendRecord(wrapRecord("proposal", durablePending, 1));
    const approvedDecision = decision(pending);
    assert.equal(f.baseStore.commitDecision(approvedDecision).ok, true);
    const target = path.join(f.root, "crash-skill", "SKILL.md");
    const child = spawn(process.execPath, [NEW_SKILL_CRASH_CHILD, path.join(f.temp, "state"), f.root, PROJECT, point], { stdio: ["ignore", "ignore", "pipe"] });
    const observed = [];
    const monitor = setInterval(() => {
      try { observed.push(fs.readFileSync(target, "utf8")); } catch (error) { if (error?.code !== "ENOENT") observed.push(`ERROR:${error.code}`); }
    }, 1);
    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, stderr }));
      });
    } finally {
      clearInterval(monitor);
    }
    assert.equal(exit.signal, "SIGKILL", exit.stderr);
    assert.equal(observed.every((value) => value === content), true, JSON.stringify(observed));
    if (fs.existsSync(target)) assert.equal(fs.readFileSync(target, "utf8"), content);

    const recoveryApplier = createApplier({ store: f.store, inventory: f.inventory, privacy: f.privacy, now: () => Date.now() });
    t.after(() => recoveryApplier.close());
    const outcomes = recoveryApplier.recoverPending();
    const outcome = outcomes.find((item) => item.proposalId === pending.id);
    if (point === "apply-after-pending-audit") {
      assert.equal(fs.existsSync(target), false);
      assert.equal(outcome.reason, "apply-not-published");
    } else if (point === "apply-after-new-target-link" || point === "apply-after-publication") {
      assert.equal(fs.readFileSync(target, "utf8"), content);
      assert.equal(outcome.ok, true);
    } else {
      assert.equal(fs.readFileSync(target, "utf8"), content);
      assert.equal(outcome, undefined);
    }
    if (fs.existsSync(target)) {
      assert.equal(hashSkillContent(fs.readFileSync(target)), pending.proposedContentHash);
      assert.deepEqual(fs.readdirSync(path.dirname(target)), ["SKILL.md"]);
    }
    assert.deepEqual(recoveryApplier.recoverPending(), []);
    assert.equal(verifiedApplies(f, pending.id).length, point === "apply-after-pending-audit" ? 0 : 1);
    if (point === "apply-after-new-target-link") assert.equal(verifiedApplies(f, pending.id)[0].payload.details.temporary, "none");
    assert.equal(recoveryApplier.getApplyLeaseStatus(pending.id).held, false);
    assert.equal(f.baseStore.getRecord("proposal", pending.id).payload.state, "approved");
  });
}

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

test("existing-target apply revalidates the canonical parent before creating its temp file", async (t) => {
  let f;
  let moved;
  let outside;
  f = fixture(t, {
    faultInjection(point) {
      if (point !== "apply-before-temp-parent-check" || moved) return;
      const parent = path.dirname(f.target);
      moved = `${parent}-moved`;
      outside = path.join(f.temp, "outside");
      fs.mkdirSync(outside);
      fs.renameSync(parent, moved);
      fs.symlinkSync(outside, parent, "dir");
    },
  });
  const result = await f.applier.applyProposal({ proposal: proposal(f), decision: decision(proposal(f)), mode: "auto" });

  assert.equal(result.ok, false);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readdirSync(moved).some((name) => name.includes("self-evolve-tmp")), false);
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

test("post-publication readback errors use the known apply details to roll back", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const originalRename = fs.renameSync;
  const originalRead = fs.readFileSync;
  let published = false;
  let failedReadback = false;
  fs.renameSync = function (from, to) {
    const value = originalRename(from, to);
    if (String(from).includes("self-evolve-tmp") && to === f.target) published = true;
    return value;
  };
  fs.readFileSync = function (target, ...args) {
    if (published && !failedReadback && target === f.target) {
      failedReadback = true;
      throw new Error("simulated-readback-error");
    }
    return originalRead(target, ...args);
  };
  let result;
  try {
    result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  } finally {
    fs.renameSync = originalRename;
    fs.readFileSync = originalRead;
  }
  assert.equal(result.reason, "simulated-readback-error");
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
  assert.equal(f.applier.circuitBreakerOpen(), false);
});

test("apply refreshes inventory for skills created after applier startup", async (t) => {
  const f = fixture(t, { existing: false });
  const directory = path.join(f.root, "late-skill");
  const target = path.join(directory, "SKILL.md");
  const before = skill("late-skill");
  fs.mkdirSync(directory);
  fs.writeFileSync(target, before);
  const p = proposal(f, {
    name: "late-skill",
    currentHash: hashSkillContent(before),
    content: skill("late-skill", "# Updated\nUse the current inventory.\n"),
  });

  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(target, "utf8"), p.proposedContent);
});

test("successful apply writes one verified apply event", async (t) => {
  const f = fixture(t);
  const p = proposal(f);
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.ok, true);
  assert.equal(verifiedApplies(f, p.id).length, 1);
  assert.equal(verifiedApplies(f, p.id)[0].payload.details.appliedHash, result.appliedHash);
});

test("successful apply reports degraded release and retains the claim for close retry", async (t) => {
  let releases = 0;
  const f = fixture(t, {
    releaseLease(baseStore, ...args) {
      releases += 1;
      return releases === 1 ? { ok: false, reason: "simulated-release-failure" } : baseStore.releaseLease(...args);
    },
  });
  const p = proposal(f);
  const result = await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" });
  assert.equal(result.ok, true);
  assert.equal(result.leaseStatus, "degraded");
  assert.equal(result.leaseWarning, "simulated-release-failure");
  assert.equal(f.applier.getApplyLeaseStatus(p.id).held, true);
  assert.equal(f.baseStore.readRecords("audit-event").some((record) => record.payload.kind === "lease"
    && record.payload.details.state === "warning" && record.payload.details.operation === "apply"), true);
  assert.deepEqual(f.applier.close(), { ok: true, unreleased: [] });
  assert.equal(f.applier.getApplyLeaseStatus(p.id).held, false);
});

test("rollback and recovery preserve successful work while surfacing lease release failure", async (t) => {
  let releases = 0;
  const f = fixture(t, {
    releaseLease(baseStore, ...args) {
      releases += 1;
      if (releases === 2 || releases === 4) return { ok: false, reason: "simulated-release-failure" };
      return baseStore.releaseLease(...args);
    },
  });
  const p = proposal(f);
  assert.equal((await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" })).ok, true);
  const rollback = f.applier.rollbackApplied({ proposalId: p.id });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.leaseStatus, "degraded");
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
  assert.equal(f.applier.close().ok, true);

  const recoveryProposal = { ...p, id: "proposal-recovery-release" };
  fs.writeFileSync(f.target, recoveryProposal.proposedContent);
  appendPending(f, recoveryProposal, {
    target: f.target,
    priorHash: hashSkillContent(f.before),
    appliedHash: recoveryProposal.proposedContentHash,
    snapshot: "none",
  });
  const recoveryApplier = createApplier({ store: f.store, inventory: f.inventory, privacy: f.privacy, now: () => ++clock });
  const recovered = recoveryApplier.recoverPending().find((item) => item.proposalId === recoveryProposal.id);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.leaseStatus, "degraded");
  assert.equal(recoveryApplier.close().ok, true);
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
  const applyAudit = f.baseStore.readRecords("audit-event").findLast((record) => record.payload.kind === "apply" && record.payload.details["readback-verified"]);
  assert.equal(applyAudit.payload.details.canonicalRoot, p.skillTarget.canonicalRoot);
  const rollback = f.applier.rollbackApplied({ proposalId: p.id, actor: "reviewer", reason: "user-request" });
  assert.equal(rollback.ok, true);
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
  assert.equal(f.baseStore.readRecords("audit-event").filter((r) => r.payload.kind === "rollback" && r.payload.details["readback-verified"]).length, 1);
});

test("rollback reports a failed durable rollback-record write", async (t) => {
  const f = fixture(t, {
    appendRecord: (store, record, ...args) => record?.kind === "rollback-record"
      ? { ok: false, reason: "rollback-record-write-denied" }
      : store.appendRecord(record, ...args),
  });
  const p = proposal(f);
  assert.equal((await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" })).ok, true);
  assert.equal(f.applier.rollbackApplied({ proposalId: p.id }).reason, "rollback-record-write-denied");
});

test("a rollback audit failure retains its snapshot without falsely tripping the breaker", async (t) => {
  let denyRollbackAudit = false;
  const f = fixture(t, {
    appendRecord: (store, record, ...args) => denyRollbackAudit
      && record?.kind === "audit-event"
      && record?.payload?.kind === "rollback"
      && record.payload.details?.state === "rolled-back"
      ? { ok: false, reason: "rollback-audit-write-denied" }
      : store.appendRecord(record, ...args),
  });
  const p = proposal(f);
  assert.equal((await f.applier.applyProposal({ proposal: p, decision: decision(p), mode: "auto" })).ok, true);
  const snapshot = f.baseStore.readRecords("audit-event")
    .findLast((record) => record.payload.kind === "apply" && record.payload.details.state === "readback-verified")
    .payload.details.snapshot;
  assert.equal(fs.existsSync(snapshot), true);

  denyRollbackAudit = true;
  const rollback = f.applier.rollbackApplied({ proposalId: p.id });
  assert.equal(rollback.reason, "rollback-audit-write-denied");
  assert.equal(rollback.rollbackCompleted, true);
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
  assert.equal(fs.existsSync(snapshot), true);
  assert.equal(f.applier.circuitBreakerOpen(), false);

  denyRollbackAudit = false;
  assert.equal(f.applier.rollbackApplied({ proposalId: p.id, reason: "retry-recording" }).ok, true);
  assert.equal(fs.existsSync(snapshot), false);
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
