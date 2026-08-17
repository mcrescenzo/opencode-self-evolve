import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  mutationLockStats,
  sweepMutationLockResidue,
  tryStateMutationLock,
  withStateMutationLock,
} from "../self-evolve-lock.js";

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

test("BH-5 a lock release that cannot unlink keeps the lock reclaimable by this process", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-release-failure-"));
  t.after(() => {
    try { chmodSync(root, 0o755); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  // Make the release unlink fail: a read-only parent directory rejects unlink.
  assert.throws(() => withStateMutationLock(root, () => {
    chmodSync(root, 0o555);
  }, { lockTimeoutMs: 500 }), /EACCES|EPERM/u);

  chmodSync(root, 0o755);
  assert.equal(existsSync(path.join(root, ".self-evolve-mutation.lock")), true, "the lock file is still on disk");

  // The lock file is owned by this still-live pid, so no peer can ever reclaim it.
  // This process must at least still be able to take and release its own lock.
  let ran = false;
  withStateMutationLock(root, () => { ran = true; }, { lockTimeoutMs: 500 });
  assert.equal(ran, true);
  assert.equal(
    existsSync(path.join(root, ".self-evolve-mutation.lock")),
    false,
    "a later successful release must clear the stranded lock file",
  );
});

// ---------------------------------------------------------------------------
// 2026-08-16 incident: a crash left a 0-byte lock file that the recovery path
// could never reap (no identity to verify), and the retry loop spun hot for the
// full timeout on every acquisition. The tests below pin the poison-quarantine
// reap, its age-gate safety, the backoff budget, atomic publication, the
// non-blocking primitive, the residue janitor, and the release-path contracts.
// ---------------------------------------------------------------------------

const DEAD_PID = 2_147_483_647;

test("incident regression: an aged 0-byte lock is quarantined and reaped", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-poison-aged-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  writeFileSync(lockPath, "");
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockPath, past, past);

  const events = [];
  const result = withStateMutationLock(root, () => "ok", {
    lockTimeoutMs: 2_000,
    onLockEvent: (event) => events.push(event),
  });
  assert.equal(result, "ok");
  assert.equal(existsSync(lockPath), false);
  assert.equal(events.filter((event) => event.event === "poison-reap").length, 1);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".lock.")), []);
});

test("a fresh 0-byte lock is NOT reaped and does not hot-spin", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-poison-fresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  writeFileSync(lockPath, "");

  const before = mutationLockStats();
  const cpuBefore = process.cpuUsage();
  assert.throws(
    () => withStateMutationLock(root, () => "unreachable", { lockTimeoutMs: 1_000 }),
    /mutation-lock-timeout/u,
  );
  const cpuDelta = process.cpuUsage(cpuBefore);
  const after = mutationLockStats();

  assert.equal(existsSync(lockPath), true, "the age gate must protect a fresh contentless lock");
  const attempts = after.attempts - before.attempts;
  assert.ok(attempts >= 2, `expected repeated attempts, saw ${attempts}`);
  assert.ok(attempts < 300, `backoff budget exceeded: ${attempts} attempts in 1s (pre-fix: ~26k)`);
  const cpuMs = (cpuDelta.user + cpuDelta.system) / 1_000;
  assert.ok(cpuMs < 250, `acquisition burned ${cpuMs}ms CPU over a 1s wait (pre-fix: ~1000ms)`);
});

test("a well-formed but nonce-less lock is reaped once aged", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-nonceless-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  writeFileSync(lockPath, `${JSON.stringify({ pid: DEAD_PID, acquiredAt: 0 })}\n`);
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockPath, past, past);

  assert.equal(withStateMutationLock(root, () => "ok", { lockTimeoutMs: 2_000 }), "ok");
  assert.equal(existsSync(lockPath), false);
});

test("a crash mid-acquire leaves no lock file and no wedge (atomic publication)", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-crash-acquire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");

  const child = spawn(process.execPath, [workerPath, root, "kill-on-create", "unused", "unused", "unused"], { stdio: "ignore" });
  const signal = await new Promise((resolve) => child.once("exit", (code, sig) => resolve(sig)));
  assert.equal(signal, "SIGKILL");

  assert.equal(existsSync(lockPath), false, "the lock must never be observable before its record is complete");
  const temps = readdirSync(root).filter((name) => /\.lock\.new\./u.test(name));
  assert.ok(temps.length <= 1, `at most one orphaned temp expected, saw ${temps}`);

  assert.equal(withStateMutationLock(root, () => "ok", { lockTimeoutMs: 500 }), "ok");

  const swept = sweepMutationLockResidue(root, { staleLockMs: 1 });
  assert.equal(swept.temps, temps.length);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".lock.")), []);
});

test("tryStateMutationLock never blocks: busy under a live foreign lock, works when free", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-try-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");

  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, nonce: "foreign-live", acquiredAt: Date.now() })}\n`);
  const started = Date.now();
  const busy = tryStateMutationLock(root, () => "unreachable");
  assert.deepEqual(busy, { ok: false, reason: "mutation-lock-busy" });
  assert.ok(Date.now() - started < 200, "a busy try must return in well under a poll interval");

  unlinkSync(lockPath);
  const free = tryStateMutationLock(root, () => "ran");
  assert.deepEqual(free, { ok: true, result: "ran" });
  assert.equal(existsSync(lockPath), false, "the try path must release its lock");
});

test("the janitor sweeps only dead-pid residue and never the lock itself", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-janitor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  const past = new Date(Date.now() - 60_000);

  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, nonce: "live-owner", acquiredAt: Date.now() })}\n`);
  const deadLink = `${lockPath}.stale.${DEAD_PID}.deadbeef00000001`;
  linkSync(lockPath, deadLink);
  utimesSync(deadLink, past, past);
  const liveLink = `${lockPath}.stale.${process.pid}.deadbeef00000002`;
  linkSync(lockPath, liveLink);
  utimesSync(liveLink, past, past);
  const claimPath = `${lockPath}.stale-recovery`;
  writeFileSync(claimPath, `${JSON.stringify({ pid: DEAD_PID, nonce: "dead-claim", acquiredAt: 0 })}\n`);
  utimesSync(claimPath, past, past);
  writeFileSync(`${lockPath}.malformed.${DEAD_PID}.deadbeef00000003`, "");
  writeFileSync(`${lockPath}.new.${DEAD_PID}.deadbeef00000004`, "");

  const counts = sweepMutationLockResidue(root, { staleLockMs: 1_000 });
  assert.deepEqual(counts, { staleLinks: 1, claims: 1, malformed: 1, temps: 1 });
  assert.equal(existsSync(lockPath), true, "the janitor must never touch the lock file");
  assert.equal(existsSync(deadLink), false);
  assert.equal(existsSync(liveLink), true, "a live pid's recovery link must survive");
  assert.equal(existsSync(claimPath), false);
  assert.equal(statSync(lockPath).nlink, 2, "only the live-pid link may remain");
});

test("a release-time failure preserves the successful action result on the error", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-release-result-"));
  t.after(() => {
    try { chmodSync(root, 0o755); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  let thrown;
  try {
    withStateMutationLock(root, () => {
      chmodSync(root, 0o555);
      return "committed";
    }, { lockTimeoutMs: 500 });
  } catch (error) {
    thrown = error;
  }
  chmodSync(root, 0o755);
  assert.ok(thrown, "release failure must still surface");
  assert.equal(thrown.actionSucceeded, true);
  assert.equal(thrown.actionResult, "committed");
  withStateMutationLock(root, () => "cleanup", { lockTimeoutMs: 500 });
});

test("L8 regression: a stranded depth-0 record never runs the action unlocked", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-l8-"));
  t.after(() => {
    try { chmodSync(root, 0o755); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const lockPath = path.join(root, ".self-evolve-mutation.lock");

  assert.throws(() => withStateMutationLock(root, () => {
    chmodSync(root, 0o555);
  }, { lockTimeoutMs: 500 }), /EACCES|EPERM/u);
  chmodSync(root, 0o755);
  assert.equal(existsSync(lockPath), true, "the stranded lock file is still on disk");

  // Simulate the on-disk lock being replaced by a foreign live owner while the
  // depth-0 record lingers: reentrant entry must detect lost ownership and NOT
  // run the action under the stranded record.
  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, nonce: "foreign-owner", acquiredAt: Date.now() })}\n`);
  let ran = false;
  assert.throws(
    () => withStateMutationLock(root, () => { ran = true; }, { lockTimeoutMs: 300 }),
    /mutation-lock-timeout/u,
  );
  assert.equal(ran, false, "the action must not execute without real on-disk ownership");
  unlinkSync(lockPath);
  assert.equal(withStateMutationLock(root, () => "recovered", { lockTimeoutMs: 500 }), "recovered");
});

test("multi-process contention: cycles serialize cleanly with zero timeouts", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-cycle-"));
  const logPath = path.join(root, "cycle-log");
  const children = [];
  const exits = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(exits);
    rmSync(root, { recursive: true, force: true });
  });

  const CYCLES = 20;
  for (let index = 0; index < 3; index += 1) {
    const worker = spawnWorker([root, "cycle", String(CYCLES), "unused", logPath, "5000", "10000"]);
    children.push(worker.child);
    exits.push(worker.exited);
  }
  await Promise.all(exits);

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 3 * CYCLES * 2);
  for (let index = 0; index < lines.length; index += 2) {
    const enter = lines[index].split(" ");
    const exit = lines[index + 1].split(" ");
    assert.equal(enter[0], "enter");
    assert.equal(exit[0], "exit");
    assert.equal(enter[1], exit[1], `interleaved critical sections at line ${index}: ${lines[index]} / ${lines[index + 1]}`);
    assert.equal(enter[2], exit[2]);
  }
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".lock.")), []);
});

test("a future-dated 0-byte lock is reaped via the monotonic cross-call fallback", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-poison-future-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  writeFileSync(lockPath, "");
  const future = new Date(Date.now() + 1_000_000);
  utimesSync(lockPath, future, future);

  // Gate = max(staleLockMs 50, 2 * lockTimeoutMs 200) = 400ms. A single 200ms
  // call cannot accrue that much monotonic observation: it records the first
  // sighting and times out with the file intact (the age-gate safety).
  assert.throws(
    () => withStateMutationLock(root, () => "unreachable", { staleLockMs: 50, lockTimeoutMs: 200 }),
    /mutation-lock-timeout/u,
  );
  assert.equal(existsSync(lockPath), true);

  await new Promise((resolve) => setTimeout(resolve, 450));

  const events = [];
  assert.equal(
    withStateMutationLock(root, () => "recovered", {
      staleLockMs: 50,
      lockTimeoutMs: 200,
      onLockEvent: (event) => events.push(event),
    }),
    "recovered",
  );
  assert.equal(existsSync(lockPath), false, "wall-clock skew must not make a poisoned lock immortal");
  assert.equal(events.filter((event) => event.event === "poison-reap").length, 1);
});

test("a live recovery claim blocks the poison quarantine until released", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-poison-claim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  const claimPath = `${lockPath}.stale-recovery`;
  writeFileSync(lockPath, "");
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockPath, past, past);
  writeFileSync(claimPath, `${JSON.stringify({ pid: process.pid, nonce: "live-claim", acquiredAt: Date.now() })}\n`);

  assert.throws(
    () => withStateMutationLock(root, () => "unreachable", { lockTimeoutMs: 300 }),
    /mutation-lock-timeout/u,
  );
  assert.equal(existsSync(lockPath), true, "no remover may act while a live peer holds the claim");

  unlinkSync(claimPath);
  assert.equal(withStateMutationLock(root, () => "ok", { lockTimeoutMs: 2_000 }), "ok");
  assert.equal(existsSync(lockPath), false);
});
