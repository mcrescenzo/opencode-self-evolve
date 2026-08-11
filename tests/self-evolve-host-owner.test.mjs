import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { recoverOrphanedAnalyzerSessions } from "../self-evolve-integration.js";
import { hashSkillContent } from "../self-evolve-inventory.js";
import { runSynthesis } from "../self-evolve-synthesis.js";
import { hashContent, HOST_OWNER_TTL_MS, openStore } from "../self-evolve-store.js";

const NOW = 2_100_000_000_000;
const PROJECT = "a".repeat(64);
const FOREIGN_PROJECT = "b".repeat(64);
const FOREIGN_ROOT = "d".repeat(64);

function fixture(t, { alive = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-host-owner-"));
  let ownerAlive = alive;
  const store = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => NOW,
    processIsAlive: () => ownerAlive,
  });
  t.after(() => {
    try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  return { root, store, setAlive(value) { ownerAlive = value; } };
}

function acquire(store, sessionId, overrides = {}) {
  return store.acquireHostOwner(sessionId, {
    agent: "self-evolve-synthesizer",
    projectFingerprint: PROJECT,
    rootIdentity: store.rootIdentity,
    generation: 1,
    ...overrides,
  });
}

function status(store, sessionId, overrides = {}) {
  return store.hostOwnerStatus(sessionId, { projectFingerprint: PROJECT, rootIdentity: store.rootIdentity, now: NOW, ...overrides });
}

function writeOwner(store, sessionId, overrides = {}) {
  writeFileSync(ownerPath(store, sessionId), `${JSON.stringify({
    schema: "self-evolve.host-owner.v1",
    sessionId,
    agent: "self-evolve-synthesizer",
    pid: process.pid,
    generation: 1,
    projectFingerprint: PROJECT,
    rootIdentity: store.rootIdentity,
    nonce: "ab".repeat(24),
    acquiredAt: NOW,
    expiresAt: NOW + HOST_OWNER_TTL_MS,
    ...overrides,
  })}\n`, { mode: 0o600 });
}

function ownerPath(store, sessionId) {
  const key = hashContent(`self-evolve-host-owner-v1\n${sessionId}`);
  return path.join(store.stateDir, "host-owners", `${key}.json`);
}

function recoveryClient(sessions, aborts, deletions) {
  return {
    session: {
      async list() { return { data: sessions }; },
      async abort(request) {
        aborts.push(request?.path?.id ?? request?.path?.sessionID ?? request?.sessionID ?? request?.id ?? request);
        return { data: {} };
      },
      async delete(request) {
        deletions.push(request?.path?.id);
        return { data: {} };
      },
    },
  };
}

test("dead matching owner is abortable while live and reused pids defer", (t) => {
  const f = fixture(t);
  const dead = acquire(f.store, "dead-session");
  assert.equal(dead.ok, true);
  assert.equal(dead.expiresAt, NOW + HOST_OWNER_TTL_MS);
  assert.equal(status(f.store, "dead-session").classification, "abortable");

  f.setAlive(true);
  assert.equal(status(f.store, "dead-session").classification, "live-owner");
  assert.equal(status(f.store, "dead-session", { now: NOW + HOST_OWNER_TTL_MS + 1 }).classification, "live-owner");
});

test("unknown and foreign same-name sessions remain non-abortable", (t) => {
  const f = fixture(t);
  assert.equal(status(f.store, "unknown-session").classification, "unknown");

  writeOwner(f.store, "foreign-session", { projectFingerprint: FOREIGN_PROJECT, rootIdentity: FOREIGN_ROOT });
  const foreign = status(f.store, "foreign-session");
  assert.equal(foreign.classification, "foreign");
  assert.equal(existsSync(ownerPath(f.store, "foreign-session")), true);
});

test("malformed and corrupt ownership records are quarantined and not abortable", (t) => {
  const f = fixture(t);
  writeFileSync(ownerPath(f.store, "malformed-session"), "{}\n", { mode: 0o600 });
  writeFileSync(ownerPath(f.store, "corrupt-session"), "{not-json\n", { mode: 0o600 });

  assert.equal(status(f.store, "malformed-session").classification, "malformed");
  assert.equal(status(f.store, "corrupt-session").classification, "corrupt");
  assert.equal(existsSync(ownerPath(f.store, "malformed-session")), false);
  assert.equal(existsSync(ownerPath(f.store, "corrupt-session")), false);
  assert.ok(readdirSync(path.join(f.store.stateDir, "quarantine")).some((name) => name.startsWith("host-owner-")));
});

test("recovery interrupts and deletes a dead owner once while deferring live, unknown, and foreign candidates", async (t) => {
  const f = fixture(t);
  for (const id of ["dead-session", "live-session"]) assert.equal(acquire(f.store, id).ok, true);
  writeOwner(f.store, "foreign-session", { rootIdentity: FOREIGN_ROOT });
  const sessions = [
    { id: "dead-session", agent: "self-evolve-synthesizer", state: "running" },
    { id: "unknown-session", agent: "self-evolve-synthesizer", state: "running" },
    { id: "foreign-session", agent: "self-evolve-synthesizer", state: "running" },
  ];
  const aborts = [];
  const deletions = [];
  const client = recoveryClient(sessions, aborts, deletions);

  const first = await recoverOrphanedAnalyzerSessions(client, "/workspace", { store: f.store, projectFingerprint: PROJECT, rootIdentity: f.store.rootIdentity, now: NOW });
  const second = await recoverOrphanedAnalyzerSessions(client, "/workspace", { store: f.store, projectFingerprint: PROJECT, rootIdentity: f.store.rootIdentity, now: NOW });

  assert.deepEqual(aborts, ["dead-session"]);
  assert.deepEqual(deletions, ["dead-session"]);
  assert.equal(first.find((item) => item.id === "dead-session")?.action, "deleted");
  assert.equal(first.find((item) => item.id === "unknown-session")?.action, "unknown");
  assert.equal(first.find((item) => item.id === "foreign-session")?.action, "foreign");
  assert.equal(second.find((item) => item.id === "dead-session")?.action, "unknown");

  f.setAlive(true);
  const liveAborts = [];
  const liveDeletions = [];
  const live = await recoverOrphanedAnalyzerSessions(recoveryClient([
    { id: "live-session", agent: "self-evolve-synthesizer", state: "running" },
  ], liveAborts, liveDeletions), "/workspace", { store: f.store, projectFingerprint: PROJECT, rootIdentity: f.store.rootIdentity, now: NOW });
  assert.deepEqual(liveAborts, []);
  assert.deepEqual(liveDeletions, []);
  assert.equal(live[0].action, "deferred");
});

test("release is nonce-bound, idempotent, and process-generation cleanup is scoped", (t) => {
  const f = fixture(t);
  const first = acquire(f.store, "owned-one", { generation: 7 });
  const second = acquire(f.store, "owned-two", { generation: 8 });
  assert.deepEqual(f.store.releaseHostOwner("owned-one", "00".repeat(24)), { ok: false, reason: "nonce-mismatch" });
  assert.deepEqual(f.store.releaseOwnedHostOwners({ pid: process.pid, generation: 7 }), { ok: true, released: 1 });
  assert.equal(status(f.store, "owned-one").classification, "unknown");
  assert.equal(status(f.store, "owned-two").classification, "abortable");
  assert.deepEqual(f.store.releaseHostOwner("owned-one", first.nonce), { ok: true, absent: true });
  assert.deepEqual(f.store.releaseHostOwner("owned-two", second.nonce), { ok: true });
});

test("store close releases every host owner acquired by that store", (t) => {
  const f = fixture(t);
  assert.equal(acquire(f.store, "close-owned-one").ok, true);
  assert.equal(acquire(f.store, "close-owned-two", { generation: 2 }).ok, true);
  assert.equal(existsSync(ownerPath(f.store, "close-owned-one")), true);
  assert.equal(existsSync(ownerPath(f.store, "close-owned-two")), true);

  assert.deepEqual(f.store.close(), { ok: true, released: 2 });
  assert.equal(existsSync(ownerPath(f.store, "close-owned-one")), false);
  assert.equal(existsSync(ownerPath(f.store, "close-owned-two")), false);
});

test("store close preserves a host owner whose nonce no longer belongs to it", (t) => {
  const f = fixture(t);
  assert.equal(acquire(f.store, "close-replaced").ok, true);
  writeOwner(f.store, "close-replaced", { nonce: "cd".repeat(24) });

  const result = f.store.close();
  assert.equal(result.ok, false);
  assert.equal(result.failures.some((failure) => failure.reason === "nonce-mismatch"), true);
  assert.equal(existsSync(ownerPath(f.store, "close-replaced")), true);
});

test("expired host owners are reclaimed only after their process is dead", (t) => {
  const f = fixture(t, { alive: true });
  assert.equal(acquire(f.store, "expired-session", { ttlMs: 1 }).ok, true);
  assert.deepEqual(f.store.cleanupExpiredHostOwners({ now: NOW + 2 }), { hostOwners: 0, quarantinedHostOwners: 0 });
  assert.equal(status(f.store, "expired-session", { now: NOW + 2 }).classification, "live-owner");
  f.setAlive(false);
  assert.deepEqual(f.store.cleanupExpiredHostOwners({ now: NOW + 2 }), { hostOwners: 1, quarantinedHostOwners: 0 });
  assert.equal(status(f.store, "expired-session", { now: NOW + 2 }).classification, "unknown");
});

test("hidden-session terminal finally removes ownership after a pre-prompt crash", async (t) => {
  const f = fixture(t);
  const currentContent = "---\nname: owner-test\ndescription: Tests owner cleanup.\n---\n\n# Owner Test\n";
  const currentHash = hashSkillContent(currentContent);
  const cluster = {
    id: "e".repeat(64),
    receiptType: "repeated-command",
    projectFingerprint: PROJECT,
    scopeFingerprint: "f".repeat(64),
    incidentIds: ["one", "two", "three"],
    occurrencesSum: 3,
    firstSeenAt: NOW - 2,
    lastSeenAt: NOW - 1,
    observations: [{ id: "1".repeat(64), createdAt: NOW - 1, receiptIds: ["2".repeat(64)], structuredFields: { receiptType: "repeated-command" }, redacted: true, injectionFlagged: false }],
    eligibility: { clusterId: "e".repeat(64), eligible: true },
  };
  const target = { canonicalRoot: "/skills", relativePath: "owner-test/SKILL.md", logicalName: "owner-test", currentHash, currentContent };
  let prompts = 0;
  let aborts = 0;
  let deletions = 0;
  const ctx = { directory: "/workspace", client: { session: {
    async create() { return { data: { id: "prompt-failure-session" } }; },
    async prompt() { prompts += 1; return { data: {} }; },
    async abort() { aborts += 1; return { data: {} }; },
    async delete() { deletions += 1; return { data: {} }; },
  } } };

  const result = await runSynthesis({
    ctx,
    cluster,
    targetSkill: target,
    inventory: [target],
    privacy: { checkPartition: () => ({ ok: true }), isObservationEligible: () => true },
    options: {
      store: f.store,
      currentContent,
      eligibility: cluster.eligibility,
      validateTarget: () => ({ ok: true }),
      projectFingerprint: PROJECT,
      rootIdentity: f.store.rootIdentity,
      hostOwnerGeneration: 9,
      faultInjection(point) { if (point === "hidden-session-after-owner-acquire") throw new Error("simulated-pre-prompt-crash"); },
    },
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(prompts, 0);
  assert.ok(aborts >= 1);
  assert.equal(deletions, 1);
  assert.equal(status(f.store, "prompt-failure-session").classification, "unknown");
});
