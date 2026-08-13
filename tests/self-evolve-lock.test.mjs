import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withStateMutationLock } from "../self-evolve-lock.js";

const workerPath = fileURLToPath(new URL("./fixtures/mutation-lock-worker.mjs", import.meta.url));

function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() >= deadline) reject(new Error("test-barrier-timeout"));
      else setTimeout(check, 2);
    };
    check();
  });
}

function spawnWorker(args) {
  const child = spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`worker failed (${code ?? signal}): ${stderr}`));
    });
  });
  return { child, exited };
}

test("reentrant mutation locks reject asynchronous actions", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => withStateMutationLock(root, () => withStateMutationLock(root, () => Promise.resolve("unsafe"))),
    /mutation-lock-action-must-be-synchronous/u,
  );
});

test("a post-create acquisition failure removes the lock file it created", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-create-failure-"));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(() => withStateMutationLock(root, () => "unreachable", {
    onLockCreated() {
      const error = new Error("injected-lock-initialization-failure");
      error.code = "EIO";
      throw error;
    },
  }), /injected-lock-initialization-failure/u);
  assert.equal(existsSync(lockPath), false);
  assert.equal(withStateMutationLock(root, () => "acquired"), "acquired");
  assert.equal(existsSync(lockPath), false);
});

test("a stale recovery claim left by a dead process self-expires", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-stale-claim-"));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  const claimPath = `${lockPath}.stale-recovery`;
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647, nonce: "stale-owner", acquiredAt: 0 })}\n`);
  writeFileSync(claimPath, `${JSON.stringify({ pid: 2_147_483_647, nonce: "dead-recovery", acquiredAt: 0 })}\n`);
  utimesSync(lockPath, new Date(0), new Date(0));
  utimesSync(claimPath, new Date(0), new Date(0));

  assert.equal(withStateMutationLock(root, () => "recovered", { staleLockMs: 1, lockTimeoutMs: 200 }), "recovered");
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(claimPath), false);
});

test("stale recovery does not displace a live replacement lock", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-"));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  const observedPath = path.join(root, "stale-observed");
  const recoverReleasePath = path.join(root, "release-recovery");
  const recoverEnteredPath = path.join(root, "recovery-entered");
  const replacementEnteredPath = path.join(root, "replacement-entered");
  const replacementReleasePath = path.join(root, "release-replacement");
  const children = [];
  const exits = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(exits);
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647, nonce: "stale", acquiredAt: 0 })}\n`);
  utimesSync(lockPath, new Date(0), new Date(0));
  const recovery = spawnWorker([root, "recovery", observedPath, recoverReleasePath, recoverEnteredPath]);
  children.push(recovery.child);
  exits.push(recovery.exited);
  await waitFor(() => existsSync(observedPath));

  unlinkSync(lockPath);
  const replacement = spawnWorker([
    root,
    "replacement",
    path.join(root, "unused"),
    replacementReleasePath,
    replacementEnteredPath,
  ]);
  children.push(replacement.child);
  exits.push(replacement.exited);
  await waitFor(() => existsSync(replacementEnteredPath));

  writeFileSync(recoverReleasePath, "release\n");
  await recovery.exited;
  assert.equal(existsSync(recoverEnteredPath), false);
  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(`${replacementEnteredPath}.displaced`), false);

  writeFileSync(replacementReleasePath, "release\n");
  await replacement.exited;
  assert.equal(existsSync(lockPath), false);
});

// ---------------------------------------------------------------------------
// H13-002: recover dead mutation locks despite future wall-clock mtime.
// A dead owner whose lock file has a future-dated mtime yields a negative
// wall-clock age, so the legacy `age >= staleLockMs` gate never fired and the
// dead lock was never reclaimed until wall-clock caught up. The monotonic
// grace path below closes that hole while retaining every existing identity
// safety check (PID liveness, inode, nonce, replacement owner).
// ---------------------------------------------------------------------------

const FUTURE_DEAD_PID = 2_147_483_647;

function seedFutureDatedLock(root, { pid = FUTURE_DEAD_PID, nonce = "future-dead", skewMs = 60_000 } = {}) {
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  writeFileSync(lockPath, `${JSON.stringify({ pid, nonce, acquiredAt: 0 })}\n`);
  const future = new Date(Date.now() + skewMs);
  utimesSync(lockPath, future, future);
  return lockPath;
}

function noReclaimArtifacts(root) {
  return readdirSync(root).filter((name) => name.startsWith(".self-evolve-mutation.lock.stale"));
}

test("a dead owner with a future-dated mtime is recovered after the monotonic grace interval", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-future-dead-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = seedFutureDatedLock(root);

  const result = withStateMutationLock(root, () => "recovered", { staleLockMs: 20, lockTimeoutMs: 5_000 });
  assert.equal(result, "recovered");
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(noReclaimArtifacts(root), []);
});

test("a live owner with a future-dated mtime is never displaced", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-future-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = seedFutureDatedLock(root, { pid: process.pid, nonce: "live-future" });

  assert.throws(
    () => withStateMutationLock(root, () => "unreachable", { staleLockMs: 20, lockTimeoutMs: 200 }),
    /mutation-lock-timeout/u,
  );
  const owner = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(owner.nonce, "live-future");
  assert.equal(owner.pid, process.pid);
  assert.deepEqual(noReclaimArtifacts(root), []);
});

test("a dead owner whose PID was reused by a live process is not displaced", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-pid-reuse-"));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map((child) => new Promise((resolve) => child.once("exit", resolve))));
    rmSync(root, { recursive: true, force: true });
  });

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(holder);
  const reusedPid = holder.pid;
  const lockPath = seedFutureDatedLock(root, { pid: reusedPid, nonce: "pid-reuse" });

  assert.throws(
    () => withStateMutationLock(root, () => "unreachable", { staleLockMs: 20, lockTimeoutMs: 200 }),
    /mutation-lock-timeout/u,
  );
  const owner = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(owner.nonce, "pid-reuse");
  assert.equal(owner.pid, reusedPid);
  assert.deepEqual(noReclaimArtifacts(root), []);
});

test("monotonic-grace recovery does not displace a live replacement lock", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-future-replace-"));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  const observedPath = path.join(root, "stale-observed");
  const recoverReleasePath = path.join(root, "release-recovery");
  const recoverEnteredPath = path.join(root, "recovery-entered");
  const replacementEnteredPath = path.join(root, "replacement-entered");
  const replacementReleasePath = path.join(root, "release-replacement");
  const children = [];
  const exits = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(exits);
    rmSync(root, { recursive: true, force: true });
  });

  seedFutureDatedLock(root, { nonce: "future-original" });
  // staleLockMs=200 forces the recovery worker through a real monotonic grace window
  // (wall-clock age is negative, so only monotonic observation can advance it).
  const recovery = spawnWorker([root, "recovery", observedPath, recoverReleasePath, recoverEnteredPath, "200", "2000"]);
  children.push(recovery.child);
  exits.push(recovery.exited);
  await waitFor(() => existsSync(observedPath));

  unlinkSync(lockPath);
  const replacement = spawnWorker([
    root,
    "replacement",
    path.join(root, "unused"),
    replacementReleasePath,
    replacementEnteredPath,
  ]);
  children.push(replacement.child);
  exits.push(replacement.exited);
  await waitFor(() => existsSync(replacementEnteredPath));

  writeFileSync(recoverReleasePath, "release\n");
  await recovery.exited;
  assert.equal(existsSync(recoverEnteredPath), false);
  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(`${replacementEnteredPath}.displaced`), false);

  writeFileSync(replacementReleasePath, "release\n");
  await replacement.exited;
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(noReclaimArtifacts(root), []);
});

test("concurrent reclaimers of a future-dated dead lock serialize without corruption", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-future-race-"));
  const enteredPathA = path.join(root, "entered-a");
  const enteredPathB = path.join(root, "entered-b");
  const children = [];
  const exits = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(exits);
    rmSync(root, { recursive: true, force: true });
  });

  seedFutureDatedLock(root, { nonce: "future-race" });
  // Two workers race through monotonic grace and the two-phase reclaim; the
  // recoveryClaimPath O_EXCL ensures only one wins at a time. Each runs a
  // trivial action (write entered marker, release) so both eventually succeed.
  const a = spawnWorker([root, "scan", path.join(root, "unused"), path.join(root, "unused"), enteredPathA, "40", "8000"]);
  const b = spawnWorker([root, "scan", path.join(root, "unused"), path.join(root, "unused"), enteredPathB, "40", "8000"]);
  children.push(a.child, b.child);
  exits.push(a.exited, b.exited);

  await Promise.all([a.exited, b.exited]);
  assert.equal(existsSync(enteredPathA), true);
  assert.equal(existsSync(enteredPathB), true);
  assert.deepEqual(noReclaimArtifacts(root), []);
});

test("clock changes during the grace window do not break monotonic recovery", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-future-clock-"));
  const enteredPath = path.join(root, "entered");
  const children = [];
  const exits = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(exits);
    rmSync(root, { recursive: true, force: true });
  });

  const lockPath = seedFutureDatedLock(root, { nonce: "clock-skew", skewMs: 1_000_000 });
  const worker = spawnWorker([root, "scan", path.join(root, "unused"), path.join(root, "unused"), enteredPath, "120", "8000"]);
  children.push(worker.child);
  exits.push(worker.exited);

  // Continuously vary the lock mtime (always future-dated) to simulate clock
  // rollback/advance. Monotonic grace keyed on inode+nonce+pid is unaffected.
  const skew = setInterval(() => {
    const offset = 500_000 + Math.floor(Math.random() * 1_500_000);
    const target = new Date(Date.now() + offset);
    try { utimesSync(lockPath, target, target); } catch { /* lock may be gone after recovery */ }
  }, 15);

  try {
    await worker.exited;
  } finally {
    clearInterval(skew);
  }
  assert.equal(existsSync(enteredPath), true);
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(noReclaimArtifacts(root), []);
});

test("a fresh attempt re-observes (per-attempt observation does not leak across calls)", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-future-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = seedFutureDatedLock(root, { nonce: "future-restart" });

  // Two short-timeout attempts: each times out before the 1000ms monotonic grace
  // can elapse. Per-attempt observation means the second attempt does NOT inherit
  // the first attempt's observation (no cross-call leak that would shortcut grace).
  for (let i = 0; i < 2; i += 1) {
    assert.throws(
      () => withStateMutationLock(root, () => "unreachable", { staleLockMs: 1_000, lockTimeoutMs: 80 }),
      /mutation-lock-timeout/u,
    );
  }
  assert.equal(existsSync(lockPath), true);

  // A fresh attempt whose timeout exceeds the grace window recovers within one call.
  assert.equal(
    withStateMutationLock(root, () => "recovered", { staleLockMs: 20, lockTimeoutMs: 5_000 }),
    "recovered",
  );
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(noReclaimArtifacts(root), []);
});

test("a dead future-dated lock that cannot reach grace within the timeout throws mutation-lock-timeout", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-future-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = seedFutureDatedLock(root, { nonce: "future-timeout" });

  assert.throws(
    () => withStateMutationLock(root, () => "unreachable", { staleLockMs: 10_000, lockTimeoutMs: 100 }),
    /mutation-lock-timeout/u,
  );
  assert.equal(existsSync(lockPath), true);
  const owner = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(owner.nonce, "future-timeout");
  assert.deepEqual(noReclaimArtifacts(root), []);
});
