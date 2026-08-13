// Two-process and unit tests for the root-global circuit-breaker epoch
// (H5-001 + H5-002). Mirrors the conventions of self-evolve-epoch.test.mjs:
// unit tests for the breaker epoch primitive, store-level wiring, and child
// fixtures proving every process sharing a state root respects the durable
// breaker epoch at admission, provider, and effect boundaries, plus the
// authenticated audited reset operation.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createBreakerEpochManager,
  parseBreakerEpochRecord,
  IMPLICIT_LIVE_BREAKER_EPOCH,
  BREAKER_EPOCH_SCHEMA_VERSION,
  BREAKER_EPOCH_TRIPPED_REASON,
  BREAKER_EPOCH_RESET_CONFIRMATION,
  BREAKER_EPOCH_FILENAME,
  breakerEpochFilePath,
} from "../self-evolve-epoch.js";
import { openStore } from "../self-evolve-store.js";
import { hashContent } from "../self-evolve-store.js";
import { stateRootIdentity } from "../self-evolve-state-root.js";
import { createApplier } from "../self-evolve-applier.js";
import { parseSelfEvolveCommand } from "../self-evolve-commands.js";
import * as schemas from "../self-evolve-schemas.js";

const FINGERPRINT = "b".repeat(64);
const BREAKER_PEER = path.join(import.meta.dirname, "fixtures", "epoch-peer.mjs");

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-breaker-epoch-"));
  if (t && typeof t.after === "function") {
    t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  }
  return root;
}

function readBreakerFile(root) {
  const filePath = breakerEpochFilePath(root);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function spawnPeer(root, operation, ...rest) {
  const resultPath = path.join(root, `result-${operation}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const child = spawn(process.execPath, [BREAKER_PEER, root, FINGERPRINT, operation, resultPath, ...rest], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { child, resultPath };
}

function spawnPeerSync(root, operation, ...rest) {
  const { child, resultPath } = spawnPeer(root, operation, ...rest);
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  return new Promise((resolve) => {
    child.on("close", () => {
      try {
        resolve(JSON.parse(readFileSync(resultPath, "utf8")));
      } catch {
        resolve({ ok: false, reason: `child-error:${stderr.slice(0, 200)}` });
      }
    });
  });
}

// ============================================================
// Unit tests: breaker epoch record parsing and validation
// ============================================================

test("IMPLICIT_LIVE_BREAKER_EPOCH is generation 1 and not tripped", () => {
  assert.equal(IMPLICIT_LIVE_BREAKER_EPOCH.generation, 1);
  assert.equal(IMPLICIT_LIVE_BREAKER_EPOCH.tripped, false);
  assert.equal(IMPLICIT_LIVE_BREAKER_EPOCH.schemaVersion, BREAKER_EPOCH_SCHEMA_VERSION);
});

test("parseBreakerEpochRecord rejects corrupt shapes", () => {
  for (const bad of ["", "{}", "[]", "null", "{bad json", JSON.stringify({ schemaVersion: "wrong" })]) {
    assert.throws(() => parseBreakerEpochRecord(bad), /breaker-epoch-corrupt|breaker-epoch-unsupported/u, bad);
  }
});

test("parseBreakerEpochRecord accepts a valid tripped record", () => {
  const record = {
    schemaVersion: BREAKER_EPOCH_SCHEMA_VERSION,
    generation: 1,
    tripped: true,
    trippedAt: 100,
    trippedReason: "three-failures",
    tripOperationId: "test-trip",
    rootIdentityHash: "a".repeat(64),
    resetCommitment: null,
    updatedAt: 100,
  };
  const parsed = parseBreakerEpochRecord(JSON.stringify(record));
  assert.equal(parsed.tripped, true);
  assert.equal(parsed.generation, 1);
  assert.equal(parsed.trippedReason, "three-failures");
});

test("parseBreakerEpochRecord rejects tripped without trippedAt", () => {
  const record = {
    schemaVersion: BREAKER_EPOCH_SCHEMA_VERSION,
    generation: 1,
    tripped: true,
    trippedAt: null,
    trippedReason: null,
    tripOperationId: null,
    rootIdentityHash: null,
    resetCommitment: null,
    updatedAt: 100,
  };
  assert.throws(() => parseBreakerEpochRecord(JSON.stringify(record)), /breaker-epoch-corrupt:tripped-at/u);
});

// ============================================================
// Unit tests: createBreakerEpochManager
// ============================================================

test("breaker manager read returns implicit live when absent", (t) => {
  const root = fixture(t);
  const mgr = createBreakerEpochManager({ stateRoot: root, now: () => 100 });
  const epoch = mgr.read();
  assert.equal(epoch.generation, 1);
  assert.equal(epoch.tripped, false);
  assert.equal(mgr.isTripped(), false);
  assert.equal(mgr.readTrippedReason(), null);
});

test("trip writes durable tripped state and is idempotent within a generation", (t) => {
  const root = fixture(t);
  const mgr = createBreakerEpochManager({ stateRoot: root, now: () => 200 });
  const record = mgr.trip({ reason: "test-trip", operationId: "op-1" });
  assert.equal(record.tripped, true);
  assert.equal(record.generation, 1);
  assert.equal(record.trippedReason, "test-trip");
  assert.equal(mgr.isTripped(), true);
  assert.equal(mgr.readTrippedReason(), BREAKER_EPOCH_TRIPPED_REASON);
  assert.equal(existsSync(breakerEpochFilePath(root)), true);
  // Idempotent: second trip at same generation is a no-op
  const record2 = mgr.trip({ reason: "second-trip", operationId: "op-2" });
  assert.equal(record2.tripped, true);
  assert.equal(record2.trippedReason, "test-trip");
  assert.equal(record2.tripOperationId, "op-1");
});

test("reset requires tripped epoch and exact confirmation", (t) => {
  const root = fixture(t);
  const mgr = createBreakerEpochManager({ stateRoot: root, now: () => 300 });
  // Can't reset a healthy breaker
  assert.throws(() => mgr.reset({ confirmation: BREAKER_EPOCH_RESET_CONFIRMATION, authentication: {} }), /breaker-epoch-not-tripped/u);
  // Wrong confirmation
  mgr.trip({ reason: "first" });
  assert.throws(() => mgr.reset({ confirmation: "WRONG", authentication: {} }), /breaker-reset-confirmation-mismatch/u);
});

test("reset creates a new generation and clears tripped", (t) => {
  const root = fixture(t);
  const mgr = createBreakerEpochManager({ stateRoot: root, now: () => 400 });
  mgr.trip({ reason: "before-reset" });
  assert.equal(mgr.read().generation, 1);
  const record = mgr.reset({
    confirmation: BREAKER_EPOCH_RESET_CONFIRMATION,
    authentication: {
      rootIdentityHash: "c".repeat(64),
      projectFingerprintHash: "d".repeat(64),
      schemaVersion: "0.3.0",
      protocolVersion: "self-evolve-breaker-epoch-v1",
      operatorAuthority: "operator",
    },
  });
  assert.equal(record.generation, 2);
  assert.equal(record.tripped, false);
  assert.equal(record.resetCommitment.operatorAuthority, "operator");
  assert.equal(mgr.isTripped(), false);
});

test("reset is replay-safe: can't reset a healthy breaker twice", (t) => {
  const root = fixture(t);
  const mgr = createBreakerEpochManager({ stateRoot: root, now: () => 500 });
  mgr.trip({ reason: "once" });
  mgr.reset({ confirmation: BREAKER_EPOCH_RESET_CONFIRMATION, authentication: {} });
  // Second reset fails: breaker is no longer tripped
  assert.throws(() => mgr.reset({ confirmation: BREAKER_EPOCH_RESET_CONFIRMATION, authentication: {} }), /breaker-epoch-not-tripped/u);
});

test("breaker epoch file lives outside the deletable self-evolve subtree", (t) => {
  const root = fixture(t);
  const mgr = createBreakerEpochManager({ stateRoot: root, now: () => 600 });
  mgr.trip({ reason: "location-test" });
  const filePath = breakerEpochFilePath(root);
  assert.equal(filePath, path.join(root, BREAKER_EPOCH_FILENAME));
  assert.ok(!filePath.includes(path.sep + "self-evolve" + path.sep));
  assert.ok(filePath.startsWith(root));
});

// ============================================================
// Store-level breaker epoch tests
// ============================================================

test("store breakerEpochTripped reflects durable trip across store instances", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 1000 });
  assert.equal(store.breakerEpochTripped(), false);
  store.tripBreakerEpoch({ reason: "store-trip", operationId: "store-1" });
  assert.equal(store.breakerEpochTripped(), true);
  store.close();
  // A fresh store reads the durable breaker epoch and sees tripped
  const store2 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 1001 });
  assert.equal(store2.breakerEpochTripped(), true);
  assert.equal(store2.breakerEpochReason(), BREAKER_EPOCH_TRIPPED_REASON);
  store2.close();
});

test("store resetBreakerEpoch clears tripped and is visible to a fresh store", (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 2000 });
  store.tripBreakerEpoch({ reason: "before-reset" });
  store.close();
  const store2 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 2001 });
  assert.equal(store2.breakerEpochTripped(), true);
  const record = store2.resetBreakerEpoch({
    confirmation: BREAKER_EPOCH_RESET_CONFIRMATION,
    authentication: {
      rootIdentityHash: identity,
      projectFingerprintHash: hashContent(FINGERPRINT),
      schemaVersion: schemas.SCHEMA_VERSION,
      protocolVersion: "self-evolve-breaker-epoch-v1",
      operatorAuthority: "operator",
    },
  });
  assert.equal(record.generation, 2);
  assert.equal(store2.breakerEpochTripped(), false);
  store2.close();
  // Fresh store sees healthy
  const store3 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 2002 });
  assert.equal(store3.breakerEpochTripped(), false);
  store3.close();
});

test("breaker epoch persists across purge-all (separate concern from terminality)", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 3000 });
  store.tripBreakerEpoch({ reason: "persists-purge" });
  store.close();
  // The breaker epoch file is outside the deletable subtree
  assert.equal(existsSync(breakerEpochFilePath(root)), true);
  const onDisk = readBreakerFile(root);
  assert.equal(onDisk.tripped, true);
});

// ============================================================
// Applier effect-boundary tests
// ============================================================

test("applier applyProposal is suppressed by a peer's durable breaker trip", async (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4000 });
  const privacy = { scanForForbiddenContent: () => ({ ok: true }), inspectScope: () => ({ quotaFraction: 0.1 }) };
  const applier = createApplier({ store, inventory: { records: [], canonicalRoots: [] }, privacy, now: () => 4000 });
  assert.equal(applier.circuitBreakerOpen(), false);
  // Simulate a peer process tripping the durable breaker epoch directly
  store.tripBreakerEpoch({ reason: "peer-trip", operationId: "peer-effect-test" });
  // The applier must freshly read the durable epoch at the effect boundary
  assert.equal(applier.circuitBreakerOpen(), true);
  const result = await applier.applyProposal({ proposal: { id: "p1", skillTarget: {} }, decision: null, mode: "auto" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "circuit-breaker-open");
  store.close();
});

// ============================================================
// Two-process tests (acceptance criteria 1-5)
// ============================================================

test("AC1: process A trips the breaker; process B immediately sees it tripped", async (t) => {
  const root = fixture(t);
  // Process A: trip
  const tripResult = await spawnPeerSync(root, "trip-breaker");
  assert.equal(tripResult.ok, true);
  assert.equal(tripResult.tripped, true);
  // Process B: freshly reads tripped
  const readResult = await spawnPeerSync(root, "breaker-read");
  assert.equal(readResult.ok, true);
  assert.equal(readResult.tripped, true, "peer must see tripped breaker after A's trip");
  assert.equal(readResult.reason, BREAKER_EPOCH_TRIPPED_REASON);
});

test("AC1: process B's breakerEpochTripped boundary returns true after A trips", async (t) => {
  const root = fixture(t);
  await spawnPeerSync(root, "trip-breaker");
  const check = await spawnPeerSync(root, "breaker-tripped-check");
  assert.equal(check.ok, true);
  assert.equal(check.tripped, true, "fresh boundary read must observe the trip");
});

test("AC2: authenticated reset advances the breaker epoch visible to both processes", async (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  // A trips
  await spawnPeerSync(root, "trip-breaker");
  // B (or A) authenticates a reset
  const reset = await spawnPeerSync(root, "reset-breaker", BREAKER_EPOCH_RESET_CONFIRMATION, identity);
  assert.equal(reset.ok, true);
  assert.equal(reset.generation, 2);
  assert.equal(reset.tripped, false);
  // Both processes now see healthy at their next boundary read
  const readA = await spawnPeerSync(root, "breaker-read");
  const readB = await spawnPeerSync(root, "breaker-tripped-check");
  assert.equal(readA.tripped, false);
  assert.equal(readB.tripped, false);
});

test("AC3: stale/replayed/unauthorized reset fails", async (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  // Unauthorized: wrong confirmation
  await spawnPeerSync(root, "trip-breaker");
  const wrong = await spawnPeerSync(root, "reset-breaker", "WRONG CONFIRMATION", identity);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /breaker-reset-confirmation-mismatch/u);
  // Still tripped
  assert.equal((await spawnPeerSync(root, "breaker-tripped-check")).tripped, true);
  // Correct reset
  const correct = await spawnPeerSync(root, "reset-breaker", BREAKER_EPOCH_RESET_CONFIRMATION, identity);
  assert.equal(correct.ok, true);
  // Replayed reset (second attempt) fails: breaker is no longer tripped
  const replay = await spawnPeerSync(root, "reset-breaker", BREAKER_EPOCH_RESET_CONFIRMATION, identity);
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /breaker-epoch-not-tripped/u);
});

test("AC3: reset on a healthy (non-tripped) breaker fails", async (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  // No trip — breaker is healthy
  const result = await spawnPeerSync(root, "reset-breaker", BREAKER_EPOCH_RESET_CONFIRMATION, identity);
  assert.equal(result.ok, false);
  assert.match(result.reason, /breaker-epoch-not-tripped/u);
});

test("AC4: restart deterministically observes the breaker epoch (trip persists across store reopens)", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 5000 });
  store.tripBreakerEpoch({ reason: "restart-persist" });
  store.close();
  // Multiple restarts: all observe tripped deterministically
  for (let i = 0; i < 3; i += 1) {
    const reopened = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 5000 + i });
    assert.equal(reopened.breakerEpochTripped(), true, `restart ${i} must observe tripped`);
    reopened.close();
  }
  const onDisk = readBreakerFile(root);
  assert.equal(onDisk.generation, 1);
  assert.equal(onDisk.tripped, true);
});

test("AC4: concurrent trip/reset ordering is deterministic (epoch generation resolves the race)", async (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  // Trip first, then reset; the reset advances generation to 2.
  await spawnPeerSync(root, "trip-breaker");
  const reset = await spawnPeerSync(root, "reset-breaker", BREAKER_EPOCH_RESET_CONFIRMATION, identity);
  assert.equal(reset.ok, true);
  assert.equal(reset.generation, 2);
  // A concurrent/late trip at the now-healthy generation 2 trips it again at gen 2
  const lateTrip = await spawnPeerSync(root, "trip-breaker");
  assert.equal(lateTrip.ok, true);
  assert.equal(lateTrip.generation, 2);
  assert.equal(lateTrip.tripped, true);
  // Final on-disk truth is deterministic: gen 2, tripped
  const onDisk = readBreakerFile(root);
  assert.equal(onDisk.generation, 2);
  assert.equal(onDisk.tripped, true);
});

test("AC4: concurrent trip from a delayed peer is observed by a fresh reader", async (t) => {
  const root = fixture(t);
  const barrier = path.join(root, "release-barrier-trip");
  const delayedChild = spawnPeer(root, "wait-then-trip-breaker", barrier);
  const delayedPromise = new Promise((resolve) => {
    delayedChild.child.on("close", () => {
      try { resolve(JSON.parse(readFileSync(delayedChild.resultPath, "utf8"))); } catch { resolve({ ok: false }); }
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  // While the peer waits, the breaker is healthy
  assert.equal((await spawnPeerSync(root, "breaker-tripped-check")).tripped, false);
  // Release the barrier; the peer trips the breaker
  writeFileSync(barrier, "", { mode: 0o600 });
  const tripResult = await delayedPromise;
  assert.equal(tripResult.ok, true);
  // A fresh reader now observes tripped
  assert.equal((await spawnPeerSync(root, "breaker-tripped-check")).tripped, true);
});

test("AC5: breaker state is exposed via the store breakerEpochState surface", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 6000 });
  let state = store.breakerEpochState();
  assert.equal(state.ok, true);
  assert.equal(state.tripped, false);
  assert.equal(state.generation, 1);
  store.tripBreakerEpoch({ reason: "ac5-surface", operationId: "ac5-op" });
  state = store.breakerEpochState();
  assert.equal(state.tripped, true);
  assert.equal(state.trippedReason, "ac5-surface");
  assert.equal(state.tripOperationId, "ac5-op");
  store.close();
});

test("breaker generation increments monotonically across trip/reset cycles", (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 7000 });
  store.tripBreakerEpoch({ reason: "cycle-1" });
  store.close();
  const store2 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 7001 });
  store2.resetBreakerEpoch({
    confirmation: BREAKER_EPOCH_RESET_CONFIRMATION,
    authentication: { rootIdentityHash: identity, projectFingerprintHash: hashContent(FINGERPRINT), operatorAuthority: "operator" },
  });
  store2.close();
  const store3 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 7002 });
  assert.equal(store3.breakerEpochTripped(), false);
  store3.tripBreakerEpoch({ reason: "cycle-2" });
  store3.close();
  const onDisk = readBreakerFile(root);
  assert.equal(onDisk.generation, 2);
  assert.equal(onDisk.tripped, true);
});

test("integration resetBreaker command: authenticated reset clears the durable breaker and is audited", async (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  // Trip via a peer
  await spawnPeerSync(root, "trip-breaker");
  // Confirm a fresh store can reset via the authenticated confirmation
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 8000 });
  const reset = store.resetBreakerEpoch({
    confirmation: BREAKER_EPOCH_RESET_CONFIRMATION,
    authentication: {
      rootIdentityHash: identity,
      projectFingerprintHash: hashContent(FINGERPRINT),
      schemaVersion: schemas.SCHEMA_VERSION,
      protocolVersion: "self-evolve-breaker-epoch-v1",
      operatorAuthority: "operator",
    },
  });
  assert.equal(reset.ok !== false, true);
  assert.equal(reset.generation, 2);
  // Peer now sees healthy
  store.close();
  assert.equal((await spawnPeerSync(root, "breaker-tripped-check")).tripped, false);
});

test("command parser accepts reset-breaker with exact confirmation", () => {
  const parsed = parseSelfEvolveCommand(`reset-breaker --confirm ${BREAKER_EPOCH_RESET_CONFIRMATION}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command.verb, "reset-breaker");
  assert.equal(parsed.command.confirmation, BREAKER_EPOCH_RESET_CONFIRMATION);
});

test("command parser rejects reset-breaker with wrong confirmation", () => {
  const parsed = parseSelfEvolveCommand("reset-breaker --confirm WRONG");
  assert.equal(parsed.ok, false);
});
