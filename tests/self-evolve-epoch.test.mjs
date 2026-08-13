import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createRootEpochManager,
  parseEpochRecord,
  IMPLICIT_LIVE_EPOCH,
  ROOT_EPOCH_SCHEMA_VERSION,
  ROOT_EPOCH_TERMINAL_REASON,
  ROOT_EPOCH_REINITIALIZE_CONFIRMATION,
  ROOT_EPOCH_FILENAME,
  epochFilePath,
} from "../self-evolve-epoch.js";
import { openStore } from "../self-evolve-store.js";
import { stateRootIdentity } from "../self-evolve-state-root.js";
import * as schemas from "../self-evolve-schemas.js";

const FINGERPRINT = "a".repeat(64);
const EPOCH_PEER = path.join(import.meta.dirname, "fixtures", "epoch-peer.mjs");

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-epoch-"));
  if (t && typeof t.after === "function") {
    t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  }
  return root;
}

function readEpochFile(root) {
  const filePath = epochFilePath(root);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function spawnPeer(root, operation, ...rest) {
  const resultPath = path.join(root, `result-${operation}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const child = spawn(process.execPath, [EPOCH_PEER, root, FINGERPRINT, operation, resultPath, ...rest], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { child, resultPath };
}

function spawnPeerSync(root, operation, ...rest) {
  const { child, resultPath } = spawnPeer(root, operation, ...rest);
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const exitCode = child.exitCode ?? 0;
  return new Promise((resolve) => {
    child.on("close", (t) => {
      try {
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        resolve(result);
      } catch {
        resolve({ ok: false, reason: `child-error:${stderr.slice(0, 200)}` });
      }
    });
  });
}

// ============================================================
// Unit tests: epoch record parsing and validation
// ============================================================

test("IMPLICIT_LIVE_EPOCH is generation 1 and non-terminal", (t) => {
  assert.equal(IMPLICIT_LIVE_EPOCH.generation, 1);
  assert.equal(IMPLICIT_LIVE_EPOCH.terminal, false);
  assert.equal(IMPLICIT_LIVE_EPOCH.schemaVersion, ROOT_EPOCH_SCHEMA_VERSION);
});

test("parseEpochRecord rejects corrupt shapes", (t) => {
  for (const bad of ["", "{}", "[]", "null", "{bad json", JSON.stringify({ schemaVersion: "wrong" })]) {
    assert.throws(() => parseEpochRecord(bad), /root-epoch-corrupt|root-epoch-unsupported/u, bad);
  }
});

test("parseEpochRecord accepts a valid terminal record", (t) => {
  const record = {
    schemaVersion: ROOT_EPOCH_SCHEMA_VERSION,
    generation: 1,
    terminal: true,
    terminalAt: 100,
    terminalOperationId: "test-terminal",
    rootIdentityHash: "a".repeat(64),
    reinitializeCommitment: null,
    updatedAt: 100,
  };
  const parsed = parseEpochRecord(JSON.stringify(record));
  assert.equal(parsed.terminal, true);
  assert.equal(parsed.generation, 1);
});

test("parseEpochRecord rejects terminal without terminalAt", (t) => {
  const record = {
    schemaVersion: ROOT_EPOCH_SCHEMA_VERSION,
    generation: 1,
    terminal: true,
    terminalAt: null,
    terminalOperationId: null,
    rootIdentityHash: null,
    reinitializeCommitment: null,
    updatedAt: 100,
  };
  assert.throws(() => parseEpochRecord(JSON.stringify(record)), /root-epoch-corrupt:terminal-at/u);
});

// ============================================================
// Unit tests: createRootEpochManager
// ============================================================

test("epoch manager read returns implicit live when absent", (t) => {
  const root = fixture(t);
  const mgr = createRootEpochManager({ stateRoot: root, now: () => 100 });
  const epoch = mgr.read();
  assert.equal(epoch.generation, 1);
  assert.equal(epoch.terminal, false);
  assert.equal(mgr.isTerminal(), false);
  assert.equal(mgr.readTerminalReason(), null);
});

test("writeTerminalEpoch writes durable terminal and is idempotent", (t) => {
  const root = fixture(t);
  const mgr = createRootEpochManager({ stateRoot: root, now: () => 200 });
  const record = mgr.writeTerminalEpoch({ terminalOperationId: "test" });
  assert.equal(record.terminal, true);
  assert.equal(record.generation, 1);
  assert.equal(mgr.isTerminal(), true);
  assert.equal(mgr.readTerminalReason(), ROOT_EPOCH_TERMINAL_REASON);
  // File exists on disk
  assert.equal(existsSync(epochFilePath(root)), true);
  // Idempotent: second call is a no-op
  const record2 = mgr.writeTerminalEpoch({ terminalOperationId: "test2" });
  assert.equal(record2.terminal, true);
  assert.equal(record2.terminalOperationId, "test");
});

test("reinitialize requires terminal epoch and exact confirmation", (t) => {
  const root = fixture(t);
  const mgr = createRootEpochManager({ stateRoot: root, now: () => 300 });
  // Can't reinitialize a live root
  assert.throws(() => mgr.reinitialize({ confirmation: ROOT_EPOCH_REINITIALIZE_CONFIRMATION, authentication: {} }), /root-epoch-not-terminal/u);
  // Wrong confirmation
  mgr.writeTerminalEpoch();
  assert.throws(() => mgr.reinitialize({ confirmation: "WRONG", authentication: {} }), /reinitialize-confirmation-mismatch/u);
});

test("reinitialize creates a new generation and clears terminal", (t) => {
  const root = fixture(t);
  const mgr = createRootEpochManager({ stateRoot: root, now: () => 400 });
  mgr.writeTerminalEpoch({ terminalOperationId: "first" });
  assert.equal(mgr.read().generation, 1);
  const record = mgr.reinitialize({
    confirmation: ROOT_EPOCH_REINITIALIZE_CONFIRMATION,
    authentication: {
      rootIdentityHash: "b".repeat(64),
      projectFingerprintHash: "c".repeat(64),
      schemaVersion: "0.3.0",
      protocolVersion: "self-evolve-root-epoch-v1",
      consentSnapshotHash: "d".repeat(64),
      operatorAuthority: "operator",
    },
  });
  assert.equal(record.generation, 2);
  assert.equal(record.terminal, false);
  assert.equal(record.reinitializeCommitment.operatorAuthority, "operator");
  assert.equal(mgr.isTerminal(), false);
});

test("reinitialize is replay-safe: can't reinitialize a live root twice", (t) => {
  const root = fixture(t);
  const mgr = createRootEpochManager({ stateRoot: root, now: () => 500 });
  mgr.writeTerminalEpoch();
  mgr.reinitialize({ confirmation: ROOT_EPOCH_REINITIALIZE_CONFIRMATION, authentication: {} });
  // Second reinitialize fails: root is no longer terminal
  assert.throws(() => mgr.reinitialize({ confirmation: ROOT_EPOCH_REINITIALIZE_CONFIRMATION, authentication: {} }), /root-epoch-not-terminal/u);
});

test("epoch file lives outside the deletable self-evolve subtree", (t) => {
  const root = fixture(t);
  const mgr = createRootEpochManager({ stateRoot: root, now: () => 600 });
  mgr.writeTerminalEpoch();
  const filePath = epochFilePath(root);
  assert.equal(filePath, path.join(root, ROOT_EPOCH_FILENAME));
  // Must NOT be under self-evolve/
  assert.ok(!filePath.includes(path.sep + "self-evolve" + path.sep));
  // Must be inside the root
  assert.ok(filePath.startsWith(root));
});

// ============================================================
// Store-level epoch tests
// ============================================================

test("store isTerminal reflects durable epoch after markRootTerminal", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 1000 });
  assert.equal(store.isTerminal(), false);
  store.markRootTerminal({ terminalOperationId: "test-store" });
  // localTerminalPending is set: store is still functional for cleanup reads
  // but rootEpochTerminalReason reflects the pending terminal
  assert.equal(store.rootEpochTerminalReason(), null); // pending, not yet definitive
  store.close();
  // A fresh store reads the durable epoch and IS terminal
  const store2 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 1001 });
  assert.equal(store2.isTerminal(), true);
  assert.equal(store2.rootEpochTerminalReason(), ROOT_EPOCH_TERMINAL_REASON);
  assert.throws(() => store2.getSettings(), /restart-required-after-purge-all|root-epoch-terminal/u);
  store2.close();
});

test("store reinitializeRoot clears terminal and allows a fresh open", (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 2000 });
  store.markRootTerminal({ terminalOperationId: "before-reinit" });
  store.close();
  // Fresh store sees terminal
  const store2 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 2001 });
  assert.equal(store2.isTerminal(), true);
  // Reinitialize
  const record = store2.reinitializeRoot({
    confirmation: ROOT_EPOCH_REINITIALIZE_CONFIRMATION,
    authentication: {
      rootIdentityHash: identity,
      projectFingerprintHash: "a".repeat(64),
      schemaVersion: schemas.SCHEMA_VERSION,
      protocolVersion: "self-evolve-root-epoch-v1",
      consentSnapshotHash: "b".repeat(64),
      operatorAuthority: "operator",
    },
  });
  assert.equal(record.generation, 2);
  assert.equal(record.terminal, false);
  assert.equal(store2.isTerminal(), false);
  store2.close();
});

test("restart alone is inert: terminal epoch persists across store reopens", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 3000 });
  store.purge({ scope: "all" });
  store.close();
  // Reopen (restart) — should be terminal
  const reopened = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 3001 });
  assert.equal(reopened.isTerminal(), true);
  assert.throws(() => reopened.getSettings(), /restart-required-after-purge-all|root-epoch-terminal/u);
  reopened.close();
  // Reopen again — still terminal
  const reopened2 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 3002 });
  assert.equal(reopened2.isTerminal(), true);
  reopened2.close();
});

// ============================================================
// Two-process tests (acceptance criteria 1-5)
// ============================================================

test("AC1: a peer process cannot admit or mutate after the terminal epoch", async (t) => {
  const root = fixture(t);
  // Process A: open store and mark terminal
  const storeA = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4000 });
  storeA.markRootTerminal({ terminalOperationId: "peer-test" });
  storeA.close();
  // Process B (child): try to mutate → must fail
  const result = await spawnPeerSync(root, "try-mutate");
  assert.equal(result.ok, false, "peer mutation must fail after terminal epoch");
  assert.match(result.reason, /restart-required-after-purge-all|root-epoch-terminal/u);
});

test("AC1: a restarted peer process is terminal on open", async (t) => {
  const root = fixture(t);
  const storeA = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4100 });
  storeA.markRootTerminal({ terminalOperationId: "restart-test" });
  storeA.close();
  // Process B: read terminal state
  const result = await spawnPeerSync(root, "read-terminal");
  assert.equal(result.terminal, true);
  assert.equal(result.reason, ROOT_EPOCH_TERMINAL_REASON);
});

test("AC2: old leases cannot be acquired after the terminal epoch", async (t) => {
  const root = fixture(t);
  const storeA = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4200 });
  storeA.markRootTerminal({ terminalOperationId: "lease-test" });
  storeA.close();
  // Process B: try to acquire a lease → must fail
  const result = await spawnPeerSync(root, "try-acquire-lease");
  assert.equal(result.ok, false);
});

test("AC3: terminal epoch is written before subtree deletion", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4300 });
  store.markRootTerminal({ terminalOperationId: "ordering-test" });
  // After markRootTerminal, the epoch file exists (terminal) but the subtree still exists
  assert.equal(existsSync(epochFilePath(root)), true);
  assert.equal(existsSync(path.join(root, "self-evolve")), true);
  // The epoch is terminal on disk
  const onDisk = readEpochFile(root);
  assert.equal(onDisk.terminal, true);
  store.close();
  // Now purge all (deletion)
  const store2 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4301 });
  store2.purge({ scope: "all" });
  store2.close();
  // Subtree is gone but epoch file persists
  assert.equal(existsSync(path.join(root, "self-evolve")), false);
  assert.equal(existsSync(epochFilePath(root)), true);
});

test("AC4: restart alone remains inert without reinitialize", async (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4400 });
  store.purge({ scope: "all" });
  store.close();
  // Multiple restarts: all inert
  for (let i = 0; i < 3; i += 1) {
    const result = await spawnPeerSync(root, "try-read-settings");
    assert.equal(result.ok, false, `restart ${i} must be inert`);
    assert.match(result.reason, /restart-required-after-purge-all|root-epoch-terminal/u);
  }
});

test("AC5: authenticated reinitialize creates a new epoch; unauthorized fails", async (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4500 });
  store.purge({ scope: "all" });
  store.close();
  // Unauthorized: wrong confirmation
  const wrong = await spawnPeerSync(root, "reinitialize", "WRONG CONFIRMATION", identity);
  assert.equal(wrong.ok, false);
  // Correct reinitialize
  const correct = await spawnPeerSync(root, "reinitialize", ROOT_EPOCH_REINITIALIZE_CONFIRMATION, identity);
  assert.equal(correct.ok, true);
  assert.equal(correct.generation, 2);
  assert.equal(correct.terminal, false);
  // Replayed reinitialize (second attempt) fails: root is no longer terminal
  const replay = await spawnPeerSync(root, "reinitialize", ROOT_EPOCH_REINITIALIZE_CONFIRMATION, identity);
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /root-epoch-not-terminal/u);
  // After reinitialize, a fresh process can mutate again
  const mutate = await spawnPeerSync(root, "try-mutate");
  assert.equal(mutate.ok, true, "fresh mutation must succeed after reinitialize");
});

test("AC5: reinitialize on a live (non-terminal) root fails", async (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  // No purge — root is live
  const result = await spawnPeerSync(root, "reinitialize", ROOT_EPOCH_REINITIALIZE_CONFIRMATION, identity);
  assert.equal(result.ok, false);
  assert.match(result.reason, /root-epoch-not-terminal/u);
});

test("cross-process: peer detects terminal during an active mutation-lock window", async (t) => {
  const root = fixture(t);
  // Start a child that waits for a barrier, then tries to mutate
  const barrier = path.join(root, "release-barrier");
  const delayedChild = spawnPeer(root, "wait-then-try-mutate", barrier);
  const delayedPromise = new Promise((resolve) => {
    delayedChild.child.on("close", (t) => {
      try {
        resolve(JSON.parse(readFileSync(delayedChild.resultPath, "utf8")));
      } catch {
        resolve({ ok: false, reason: "child-failed" });
      }
    });
  });
  // Give the child time to open the store and wait at the barrier
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Mark terminal from this process
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4600 });
  store.markRootTerminal({ terminalOperationId: "cross-process-test" });
  store.close();
  // Release the barrier
  writeFileSync(barrier, "", { mode: 0o600 });
  // The delayed child's mutation must fail
  const result = await delayedPromise;
  assert.equal(result.ok, false, "delayed peer mutation must fail after terminal epoch");
  assert.match(result.reason, /restart-required-after-purge-all|root-epoch-terminal/u);
});

test("epoch generation increments monotonically across terminal/reinitialize cycles", (t) => {
  const root = fixture(t);
  const identity = stateRootIdentity(root);
  const store = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4700 });
  store.markRootTerminal({ terminalOperationId: "cycle-1" });
  store.close();
  const store2 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4701 });
  store2.reinitializeRoot({
    confirmation: ROOT_EPOCH_REINITIALIZE_CONFIRMATION,
    authentication: { rootIdentityHash: identity, projectFingerprintHash: "a".repeat(64), operatorAuthority: "operator" },
  });
  store2.close();
  // After reinitialize, the store reopened should see gen 2 and be live
  // (but subtree was deleted by reinitialize flow, so a fresh open recreates it)
  const store3 = openStore(root, { projectFingerprint: FINGERPRINT, now: () => 4702 });
  assert.equal(store3.isTerminal(), false);
  // Mark terminal again → gen 2
  store3.markRootTerminal({ terminalOperationId: "cycle-2" });
  store3.close();
  const onDisk = readEpochFile(root);
  assert.equal(onDisk.generation, 2);
  assert.equal(onDisk.terminal, true);
});
